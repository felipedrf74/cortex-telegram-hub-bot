// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import {
  canConsumeConfirmedContentWorkSchedule,
  readContentMeshContext,
  readCookingMeshContext,
  readFinanceMeshContext,
  readSecretaryMeshContext,
  readTrainingMeshContext,
  type ContentMeshContext,
  type CookingMeshContext,
  type FinanceMeshContext,
  type MeshSignalDraft,
  type SecretaryMeshContext,
  type TrainingMeshContext,
} from './cross-agent-learning';
import { invalidateContextCache } from './context-engine';
import { formatCurrencyAmount } from './finance-tracker';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { resolveChatTenantId } from './chat-tenant-scope';

const CONTEXT_TTL_MS = 30_000;
const _sharedDecisionContextCache = new Map<string, {
  text: string;
  contracts: SharedDecisionContracts;
  expiresAt: number;
}>();

type MeshBundle = {
  training: TrainingMeshContext | null;
  cooking: CookingMeshContext | null;
  finance: FinanceMeshContext | null;
  content: ContentMeshContext | null;
  secretary: SecretaryMeshContext | null;
};

type PeerSkill = 'training' | 'cooking' | 'finance' | 'content' | 'secretary';
export type ContentCrossSkillPeer = Exclude<PeerSkill, 'content'>;
type SharedContextFreshness = 'active' | 'expiring' | 'stale' | 'unknown';

const CONTENT_CROSS_SKILL_PEERS: readonly ContentCrossSkillPeer[] = [
  'training',
  'secretary',
  'finance',
  'cooking',
] as const;

/**
 * Purpose limitation for peer-skill facts entering a Content prompt.
 *
 * `coarse` is the default and exposes only presentation-safe capacity
 * constraints. `presentation_safe` requires explicit, per-turn user intent and
 * is restricted to the named peer skills. Neither mode exposes raw records,
 * amounts, percentages, event titles, session prescriptions, inbox counts, or
 * meal-gap details.
 */
export interface ContentCrossSkillContextPolicy {
  purpose: 'content_planning';
  disclosure: 'coarse' | 'presentation_safe';
  allowedPeerSkills: ContentCrossSkillPeer[];
  explicitUserIntent: boolean;
}

export interface SharedDecisionContextOptions {
  /** The authenticated user's current-turn text; the service re-derives consent from it. */
  contentPurpose?: { userMessage: string };
}

/**
 * Resolve a narrow, per-turn Content context grant from the user's own words.
 * Merely writing *about* training, food, finance, or calendars is not consent
 * to read private Nexus state. The request must contain an explicit use/
 * consideration verb and name the domain. Prompt-injection language always
 * falls back to the coarse default.
 */
export function resolveContentCrossSkillContextPolicy(
  message?: string | null,
): ContentCrossSkillContextPolicy {
  const text = (message ?? '').trim().toLowerCase();
  const injectionAttempt = /\b(?:ignore|bypass|override)\b.{0,40}\b(?:privacy|consent|permission|security|policy|tenant)\b/.test(text)
    || /\b(?:ignora|contorna|ultrapassa|substitui)\b.{0,40}\b(?:privacidade|consentimento|permiss[aã]o|seguran[cç]a|pol[ií]tica|tenant)\b/.test(text);
  if (!text || injectionAttempt || !hasExplicitContentContextPurpose(text)) {
    return defaultContentCrossSkillContextPolicy();
  }

  const allowedPeerSkills = CONTENT_CROSS_SKILL_PEERS.filter((skill) =>
    explicitlyNamesContentPeer(text, skill),
  );
  if (allowedPeerSkills.length === 0) {
    return defaultContentCrossSkillContextPolicy();
  }

  return {
    purpose: 'content_planning',
    disclosure: 'presentation_safe',
    allowedPeerSkills: [...allowedPeerSkills],
    explicitUserIntent: true,
  };
}

function defaultContentCrossSkillContextPolicy(): ContentCrossSkillContextPolicy {
  return {
    purpose: 'content_planning',
    disclosure: 'coarse',
    allowedPeerSkills: [...CONTENT_CROSS_SKILL_PEERS],
    explicitUserIntent: false,
  };
}

function hasExplicitContentContextPurpose(text: string): boolean {
  return /\b(?:use|using|consider|factor(?:ing)? in|account(?:ing)? for|take into account|base(?:d)? on|coordinate with|adapt to|fit around|plan around|check|look at)\b/.test(text)
    || /\b(?:usar|usa|usando|considerar|considera|considerando|levar em conta|ter em conta|basear(?:-se)? em|com base em|coordenar com|adaptar a|encaixar em torno|planejar em torno|planear em torno|verificar|consultar)\b/.test(text);
}

function explicitlyNamesContentPeer(text: string, skill: ContentCrossSkillPeer): boolean {
  switch (skill) {
    case 'training':
      return /\b(?:my|the saved|nexus|current nexus)\s+(?:training|workout|recovery|training load|training schedule|sessions?)\b/.test(text)
        || /\b(?:training|workout|recovery)\s+(?:context|data|state|capacity|schedule)\b/.test(text)
        || /\b(?:meu|minha|o meu|a minha)\s*(?:treino|treinos|recupera[cç][aã]o|carga de treino|agenda de treino|sess(?:a|ã)o|sess(?:o|õ)es)\b/.test(text)
        || /\b(?:treino|recupera[cç][aã]o)\s+(?:contexto|dados|estado|capacidade|agenda)\b/.test(text);
    case 'secretary':
      return /\b(?:my|the saved|nexus|current nexus)\s+(?:calendar|schedule|availability|agenda|meetings?|focus time)\b/.test(text)
        || /\b(?:calendar|schedule)\s+(?:context|data|state|availability|constraints?)\b/.test(text)
        || /\b(?:meu|minha|o meu|a minha)\s*(?:calend[aá]rio|agenda|disponibilidade|reuni(?:a|ã)o|reuni(?:o|õ)es|tempo de foco)\b/.test(text)
        || /\b(?:calend[aá]rio|agenda)\s+(?:contexto|dados|estado|disponibilidade|restri[cç][oõ]es)\b/.test(text);
    case 'finance':
      return /\b(?:my|the saved|nexus|current nexus)\s+(?:budget|finances?|spending|cost constraints?|money)\b/.test(text)
        || /\b(?:budget|finance)\s+(?:context|data|state|constraints?|posture)\b/.test(text)
        || /\b(?:meu|minha|o meu|a minha)\s*(?:or[cç]amento|finan[cç]as|gastos?|custos?|dinheiro)\b/.test(text)
        || /\b(?:or[cç]amento|finan[cç]as)\s+(?:contexto|dados|estado|restri[cç][oõ]es|postura)\b/.test(text);
    case 'cooking':
      return /\b(?:my|the saved|nexus|current nexus)\s+(?:meal plan|meals?|food prep|cooking|nutrition|fueling)\b/.test(text)
        || /\b(?:meal|cooking|nutrition|fueling)\s+(?:context|data|state|capacity|plan|constraints?)\b/.test(text)
        || /\b(?:meu|minha|o meu|a minha)\s*(?:plano de refei[cç][oõ]es|refei[cç][aã]o|refei[cç][oõ]es|preparo de comida|cozinha|nutri[cç][aã]o|abastecimento)\b/.test(text)
        || /\b(?:refei[cç][oõ]es|cozinha|nutri[cç][aã]o)\s+(?:contexto|dados|estado|capacidade|plano|restri[cç][oõ]es)\b/.test(text);
  }
}

export interface PeerDecisionContract {
  nonNegotiables: string[];
  preferredWindows: string[];
  fallbackIfDeferred: string[];
  budgetMode?: string | null;
  notes: string[];
}

export type SharedDecisionContracts = Partial<Record<PeerSkill, PeerDecisionContract>>;

export function resetSharedDecisionContextCacheForTests(): void {
  invalidateSharedDecisionContextCache();
}

export function invalidateSharedDecisionContextCache(userId?: number, tenantId?: number): void {
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    const tenantKey = resolveChatTenantId(userId, tenantId);
    const prefix = `${tenantKey}:${userId}:`;
    for (const key of _sharedDecisionContextCache.keys()) {
      if (key.startsWith(prefix)) {
        _sharedDecisionContextCache.delete(key);
      }
    }
    return;
  }

  _sharedDecisionContextCache.clear();
}

export function invalidateSharedContextForSkillChange(input: {
  userId?: number;
  tenantId?: number;
  sourceSkill?: PeerSkill | 'chat' | 'calendar' | 'integration' | 'system';
  reason?: string;
} = {}): void {
  invalidateSharedDecisionContextCache(input.userId, input.tenantId);
  invalidateContextCache(input.userId, input.tenantId);
}

export async function buildSharedDecisionContext(
  domain: DomainName,
  userId: number,
  tenantId?: number,
  options: SharedDecisionContextOptions = {},
): Promise<string> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId, tenantId, options);
  return artifacts.text;
}

export async function buildSharedDecisionContracts(
  domain: DomainName,
  userId: number,
  tenantId?: number,
  options: SharedDecisionContextOptions = {},
): Promise<SharedDecisionContracts> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId, tenantId, options);
  return artifacts.contracts;
}

async function buildSharedDecisionArtifacts(
  domain: DomainName,
  userId: number,
  tenantId?: number,
  options: SharedDecisionContextOptions = {},
): Promise<{ text: string; contracts: SharedDecisionContracts }> {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'shared_decision_context',
      operation: 'build_shared_decision_context',
      reason: 'invalid_user_scope',
      userId: userId ?? null,
      details: {
        domain,
      },
    });
    return { text: '', contracts: {} };
  }

  const resolvedTenantId = resolveChatTenantId(userId, tenantId);
  if (resolvedTenantId !== userId) {
    recordTenantScopeAnomaly({
      layer: 'shared_decision_context',
      operation: 'build_shared_decision_context',
      reason: 'tenant_mismatch',
      userId,
      details: {
        domain,
        tenantId: resolvedTenantId,
        note: 'Peer mesh readers are user-scoped; refusing cross-tenant prompt context until tenant-aware mesh reads exist.',
      },
    });
    return { text: '', contracts: {} };
  }

  const contentPolicy = domain === 'content'
    ? resolveContentCrossSkillContextPolicy(options.contentPurpose?.userMessage)
    : null;
  const policyCacheKey = contentPolicy
    ? `${contentPolicy.disclosure}:${contentPolicy.explicitUserIntent ? 'explicit' : 'default'}:${contentPolicy.allowedPeerSkills.join(',')}`
    : 'standard';
  const cacheKey = `${resolvedTenantId}:${userId}:${domain}:${policyCacheKey}`;
  const cached = _sharedDecisionContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return {
      text: cached.text,
      contracts: cached.contracts,
    };
  }

  const rawBundle = await readRelevantPeerContexts(domain, userId, resolvedTenantId, contentPolicy);
  const filtered = filterStaleBundle(rawBundle);
  const bundle = contentPolicy
    ? filterBundleForContentPolicy(filtered.bundle, contentPolicy)
    : filtered.bundle;
  const staleSignals = contentPolicy
    ? filtered.staleSignals.filter(({ skill }) => contentPolicy.allowedPeerSkills.includes(skill as ContentCrossSkillPeer))
    : filtered.staleSignals;
  const sections = buildSectionsForDomain(domain, bundle, contentPolicy);
  const sourceLines = contentPolicy
    ? buildContentSourceAttributionLines(bundle, contentPolicy)
    : buildSourceAttributionLines(bundle);
  const staleLines = contentPolicy
    ? buildContentStaleContextLines(staleSignals, contentPolicy)
    : buildStaleContextLines(staleSignals);
  const text = sections.length > 0 || staleLines.length > 0
    ? [
      `<shared_decision_context domain="${domain}">`,
      `<context_scope tenant_id="${resolvedTenantId}" user_id="${userId}" visibility="user_private" cache_ttl_ms="${CONTEXT_TTL_MS}" />`,
      ...(contentPolicy
        ? [`<purpose_gate purpose="${contentPolicy.purpose}" disclosure="${contentPolicy.disclosure}" explicit_user_intent="${contentPolicy.explicitUserIntent}" allowed_peer_skills="${contentPolicy.allowedPeerSkills.join(',')}" />`]
        : []),
      '<source_attribution>',
      ...(sourceLines.length > 0 ? sourceLines : ['- none: no fresh peer-skill signals available']),
      '</source_attribution>',
      '<skill_ownership_boundaries>',
      ...buildSkillOwnershipLines(domain, contentPolicy?.allowedPeerSkills),
      '</skill_ownership_boundaries>',
      ...(staleLines.length > 0
        ? [
            '<stale_context>',
            ...staleLines,
            '</stale_context>',
          ]
        : []),
      '<downstream_update_signals>',
      ...buildDownstreamUpdateLines(domain, bundle),
      '</downstream_update_signals>',
      'Use this peer-skill context when making tradeoffs:',
      ...sections.map((section) => `- ${section}`),
      '</shared_decision_context>',
    ].join('\n')
    : '';
  const contracts = buildContractsForDomain(domain, bundle, contentPolicy);

  _sharedDecisionContextCache.set(cacheKey, {
    text,
    contracts,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  });
  return { text, contracts };
}

async function readRelevantPeerContexts(
  domain: DomainName,
  userId: number,
  tenantId: number,
  contentPolicy: ContentCrossSkillContextPolicy | null,
): Promise<MeshBundle> {
  const contentAllows = (skill: ContentCrossSkillPeer): boolean =>
    domain !== 'content' || contentPolicy?.allowedPeerSkills.includes(skill) === true;
  const needsTraining = domain !== 'triathlon' && contentAllows('training');
  const needsCooking = (domain === 'triathlon' || domain === 'secretary' || domain === 'content' || domain === 'finance')
    && contentAllows('cooking');
  const needsFinance = (domain === 'triathlon' || domain === 'secretary' || domain === 'cooking' || domain === 'content')
    && contentAllows('finance');
  const needsContent = domain === 'triathlon' || domain === 'secretary' || domain === 'finance' || domain === 'cooking';
  const needsSecretary = (domain === 'triathlon' || domain === 'cooking' || domain === 'content')
    && contentAllows('secretary');

  const [training, cooking, finance, content, secretary] = await Promise.allSettled([
    needsTraining ? readTrainingMeshContext({ userId, tenantId }) : Promise.resolve(null),
    needsCooking ? readCookingMeshContext({ userId, tenantId }) : Promise.resolve(null),
    needsFinance ? readFinanceMeshContext({ userId, tenantId }) : Promise.resolve(null),
    needsContent ? readContentMeshContext({ userId, tenantId }) : Promise.resolve(null),
    needsSecretary ? readSecretaryMeshContext({ userId, tenantId }) : Promise.resolve(null),
  ]);

  return {
    training: training.status === 'fulfilled' ? training.value : null,
    cooking: cooking.status === 'fulfilled' ? cooking.value : null,
    finance: finance.status === 'fulfilled' ? finance.value : null,
    content: content.status === 'fulfilled' ? content.value : null,
    secretary: secretary.status === 'fulfilled' ? secretary.value : null,
  };
}

function filterBundleForContentPolicy(
  bundle: MeshBundle,
  policy: ContentCrossSkillContextPolicy,
): MeshBundle {
  const allows = (skill: ContentCrossSkillPeer): boolean => policy.allowedPeerSkills.includes(skill);
  return {
    training: allows('training') ? bundle.training : null,
    cooking: allows('cooking') ? bundle.cooking : null,
    finance: allows('finance') ? bundle.finance : null,
    content: null,
    secretary: allows('secretary') ? bundle.secretary : null,
  };
}

function filterStaleBundle(bundle: MeshBundle): { bundle: MeshBundle; staleSignals: Array<{ skill: PeerSkill; signal: MeshSignalDraft }> } {
  const staleSignals: Array<{ skill: PeerSkill; signal: MeshSignalDraft }> = [];
  return {
    staleSignals,
    bundle: {
      training: filterStaleContextSignals('training', bundle.training, staleSignals),
      cooking: filterStaleContextSignals('cooking', bundle.cooking, staleSignals),
      finance: filterStaleContextSignals('finance', bundle.finance, staleSignals),
      content: filterStaleContextSignals('content', bundle.content, staleSignals),
      secretary: filterStaleContextSignals('secretary', bundle.secretary, staleSignals),
    },
  };
}

function filterStaleContextSignals<T extends { derivedSignals: MeshSignalDraft[] }>(
  skill: PeerSkill,
  context: T | null,
  staleSignals: Array<{ skill: PeerSkill; signal: MeshSignalDraft }>,
): T | null {
  if (!context) return null;
  const freshSignals = context.derivedSignals.filter((signal) => {
    if (signalFreshness(signal) !== 'stale') return true;
    staleSignals.push({ skill, signal });
    return false;
  });
  if (freshSignals.length === context.derivedSignals.length) return context;
  return { ...context, derivedSignals: freshSignals };
}

function buildSourceAttributionLines(bundle: MeshBundle): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [skill, context] of Object.entries(bundle) as Array<[PeerSkill, { derivedSignals?: MeshSignalDraft[] } | null]>) {
    for (const signal of context?.derivedSignals ?? []) {
      const line = formatSourceAttributionLine(skill, signal);
      const sourceAgent = signal.sourceAgent ?? 'unknown';
      const dedupeKey = `${skill}:${sourceAgent}:${signal.signalType}:${stableSignalPayload(signal.payload)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      lines.push(line);
    }
  }
  return lines.sort();
}

/** Content prompts receive provenance without signal names or payloads. */
function buildContentSourceAttributionLines(
  bundle: MeshBundle,
  policy: ContentCrossSkillContextPolicy,
): string[] {
  const lines: string[] = [];
  for (const skill of policy.allowedPeerSkills) {
    const context = bundle[skill];
    if (!context || context.derivedSignals.length === 0) continue;
    const sources = dedupeStrings(context.derivedSignals
      .map((signal) => signal.sourceAgent?.trim() || 'unknown'))
      .sort();
    lines.push(`- ${skill}: presentation-safe derived constraint; sources=${sources.join(',')}`);
  }
  return lines;
}

function formatSourceAttributionLine(skill: PeerSkill, signal: MeshSignalDraft): string {
  const freshness = signalFreshness(signal);
  const confidence = estimateSignalConfidence(signal);
  const expiresAt = signal.expiresAt ?? 'unknown';
  const sourceAgent = signal.sourceAgent ?? 'unknown';
  const priority = signal.priority ?? 'normal';
  const meshPriority = signal.meshPriority ?? 'unknown';
  return `- ${skill}.${signal.signalType}: source=${sourceAgent}; freshness=${freshness}; confidence=${confidence.toFixed(2)}; priority=${priority}; meshPriority=${meshPriority}; expiresAt=${expiresAt}`;
}

function buildStaleContextLines(staleSignals: Array<{ skill: PeerSkill; signal: MeshSignalDraft }>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { skill, signal } of staleSignals) {
    const sourceAgent = signal.sourceAgent ?? 'unknown';
    const key = `${skill}:${sourceAgent}:${signal.signalType}:${signal.expiresAt ?? 'unknown'}:${stableSignalPayload(signal.payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${skill}.${signal.signalType}: ignored stale signal from ${sourceAgent}; expiredAt=${signal.expiresAt ?? 'unknown'}`);
  }
  return lines.sort();
}

function buildContentStaleContextLines(
  staleSignals: Array<{ skill: PeerSkill; signal: MeshSignalDraft }>,
  policy: ContentCrossSkillContextPolicy,
): string[] {
  const staleSkills = dedupeStrings(staleSignals
    .map(({ skill }) => skill)
    .filter((skill): skill is ContentCrossSkillPeer =>
      skill !== 'content' && policy.allowedPeerSkills.includes(skill as ContentCrossSkillPeer),
    ));
  return staleSkills.map((skill) => `- ${skill}: ignored stale derived constraints`);
}

function buildSkillOwnershipLines(
  domain: DomainName,
  allowedContentPeers?: ContentCrossSkillPeer[],
): string[] {
  const target = domain === 'triathlon' ? 'training' : domain;
  const ownership = [
    '- Secretary owns schedule placement, agenda feasibility, reminders, reflow, and calendar arbitration.',
    '- Training owns workout content, recovery logic, and training-plan shape.',
    '- Cooking owns meals, groceries, meal prep, and fueling content.',
    '- Finance owns budget, bill, subscription, tax, and purchase constraints.',
    '- Content owns content workload, references, production cadence, and publish-preparation state; external publication tracking is not supported.',
  ];
  if (domain !== 'content' || !allowedContentPeers) {
    return [...ownership, `- This context is advisory for ${target}; downstream writes still belong to the owning skill.`];
  }
  const labels: Record<ContentCrossSkillPeer, string> = {
    secretary: 'Secretary',
    training: 'Training',
    cooking: 'Cooking',
    finance: 'Finance',
  };
  return [
    ...ownership.filter((line) =>
      line.startsWith('- Content owns')
      || allowedContentPeers.some((skill) => line.startsWith(`- ${labels[skill]} owns`)),
    ),
    '- Peer facts are purpose-limited, presentation-safe constraints; they do not authorize cross-skill writes.',
  ];
}

function buildDownstreamUpdateLines(domain: DomainName, bundle: MeshBundle): string[] {
  const presentSkills = (Object.entries(bundle) as Array<[PeerSkill, { derivedSignals?: MeshSignalDraft[] } | null]>)
    .filter(([, context]) => (context?.derivedSignals?.length ?? 0) > 0)
    .map(([skill]) => skill);
  if (presentSkills.length === 0) {
    return ['- No fresh peer-skill signals; ask or refresh before making cross-skill tradeoffs.'];
  }
  return dedupeStrings(presentSkills.map((skill) =>
    `- If ${skill} changes its source state, invalidate shared context and refresh ${domain} before acting from cached tradeoffs.`,
  ));
}

function signalFreshness(signal: MeshSignalDraft): SharedContextFreshness {
  if (!signal.expiresAt) return 'unknown';
  const expiresAt = Date.parse(signal.expiresAt);
  if (!Number.isFinite(expiresAt)) return 'unknown';
  const now = Date.now();
  if (expiresAt <= now) return 'stale';
  if (expiresAt - now <= 60 * 60 * 1000) return 'expiring';
  return 'active';
}

function estimateSignalConfidence(signal: MeshSignalDraft): number {
  const payloadConfidence = (signal.payload as Record<string, unknown> | undefined)?.confidence;
  if (typeof payloadConfidence === 'number' && Number.isFinite(payloadConfidence)) {
    return Math.max(0, Math.min(1, payloadConfidence));
  }
  if (typeof payloadConfidence === 'string') {
    switch (payloadConfidence.toLowerCase()) {
      case 'high':
        return 0.9;
      case 'medium':
      case 'moderate':
        return 0.7;
      case 'low':
        return 0.45;
    }
  }
  switch (signal.meshPriority) {
    case 1:
      return 0.92;
    case 2:
      return 0.84;
    case 3:
      return 0.72;
    case 4:
      return 0.58;
    default:
      return 0.5;
  }
}

function stableSignalPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, Object.keys(payload).sort());
  } catch {
    return String(payload);
  }
}

function buildSectionsForDomain(
  domain: DomainName,
  bundle: MeshBundle,
  contentPolicy: ContentCrossSkillContextPolicy | null,
): string[] {
  switch (domain) {
    case 'triathlon':
      return compact([
        summarizeSecretaryForTraining(bundle.secretary),
        summarizeCookingForTraining(bundle.cooking),
        summarizeFinanceForTraining(bundle.finance),
        summarizeContentForTraining(bundle.content),
      ]);
    case 'cooking':
      return compact([
        summarizeTrainingForCooking(bundle.training),
        summarizeSecretaryForCooking(bundle.secretary),
        summarizeFinanceForCooking(bundle.finance),
        summarizeContentForCooking(bundle.content),
      ]);
    case 'content':
      return compact([
        summarizeTrainingForContent(bundle.training, contentPolicy?.disclosure ?? 'coarse'),
        summarizeSecretaryForContent(bundle.secretary, contentPolicy?.disclosure ?? 'coarse'),
        summarizeFinanceForContent(bundle.finance, contentPolicy?.disclosure ?? 'coarse'),
        summarizeCookingForContent(bundle.cooking, contentPolicy?.disclosure ?? 'coarse'),
      ]);
    case 'finance':
      return compact([
        summarizeTrainingForFinance(bundle.training),
        summarizeCookingForFinance(bundle.cooking),
        summarizeContentForFinance(bundle.content),
      ]);
    case 'secretary':
      return compact([
        summarizeTrainingForSecretary(bundle.training),
        summarizeCookingForSecretary(bundle.cooking),
        summarizeFinanceForSecretary(bundle.finance),
        summarizeContentForSecretary(bundle.content),
      ]);
    default:
      return [];
  }
}

function buildContractsForDomain(
  domain: DomainName,
  bundle: MeshBundle,
  contentPolicy: ContentCrossSkillContextPolicy | null,
): SharedDecisionContracts {
  switch (domain) {
    case 'secretary':
      return compactContracts({
        training: buildTrainingContractForSecretary(bundle.training),
        cooking: buildCookingContractForSecretary(bundle.cooking),
        finance: buildFinanceContractForSecretary(bundle.finance),
        content: buildContentContractForSecretary(bundle.content),
      });
    case 'triathlon':
      return compactContracts({
        secretary: buildSecretaryContractForTraining(bundle.secretary),
        cooking: buildCookingContractForTraining(bundle.cooking),
        finance: buildFinanceContractForTraining(bundle.finance),
        content: buildContentContractForTraining(bundle.content),
      });
    case 'cooking':
      return compactContracts({
        training: buildTrainingContractForCooking(bundle.training),
        secretary: buildSecretaryContractForCooking(bundle.secretary),
        finance: buildFinanceContractForCooking(bundle.finance),
        content: buildContentContractForCooking(bundle.content),
      });
    case 'content':
      return compactContracts({
        training: buildTrainingContractForContent(bundle.training, contentPolicy?.disclosure ?? 'coarse'),
        secretary: buildSecretaryContractForContent(bundle.secretary, contentPolicy?.disclosure ?? 'coarse'),
        finance: buildFinanceContractForContent(bundle.finance, contentPolicy?.disclosure ?? 'coarse'),
        cooking: buildCookingContractForContent(bundle.cooking, contentPolicy?.disclosure ?? 'coarse'),
      });
    case 'finance':
      return compactContracts({
        training: buildTrainingContractForFinance(bundle.training),
        cooking: buildCookingContractForFinance(bundle.cooking),
        content: buildContentContractForFinance(bundle.content),
      });
    default:
      return {};
  }
}

function summarizeTrainingForSecretary(training: TrainingMeshContext | null): string {
  if (!training) return '';
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const hardDays = extractHardDayCount(training);
  const completion = extractSafeTrainingCompletionSummary(training);
  if (!recovery && !session && !immovability && hardDays == null && !completion) return '';

  const facts: string[] = [];
  if (recovery) facts.push(`recovery is ${recovery.state}`);
  if (session) facts.push(`next key session is ${session.title} on ${session.date}`);
  if (immovability) facts.push(`session immovability is ${immovability.level} for ${immovability.title}`);
  if (hardDays != null) facts.push(`${hardDays} hard day(s) are planned this week`);
  if (completion) {
    facts.push(`latest training disposition is ${completion.completionState}`);
    if (completion.hasDiscomfort) facts.push('discomfort reported');
    if (completion.hasReadiness) facts.push('readiness feedback recorded');
    if (completion.skippedReasonCode) facts.push(`skip reason code is ${completion.skippedReasonCode}`);
  }
  return formatSection('Training', facts, 'Protect high-cost training windows before moving the day around.');
}

function summarizeCookingForSecretary(cooking: CookingMeshContext | null): string {
  if (!cooking) return '';
  const window = extractMealWindow(cooking);
  const spend = extractGroceryForecast(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  const fuelingSupport = extractFuelingSupportStatus(cooking);
  if (!window && spend == null && !readiness && !fuelingSupport) return '';

  const facts: string[] = [];
  if (window) {
    facts.push(
      window.missingDates.length > 0
        ? `${window.missingDates.length} day(s) still have no meals planned`
        : `meal coverage is mapped for all ${window.coveredDays.length} covered day(s)`,
    );
  }
  if (fuelingSupport) {
    facts.push(
      fuelingSupport.hardDatesMissingMeals.length > 0
        ? `fueling support is ${fuelingSupport.status} with ${fuelingSupport.hardDatesMissingMeals.length} hard training day(s) still lacking meals`
        : `fueling support is ${fuelingSupport.status}`,
    );
  }
  if (readiness) facts.push(`execution readiness is ${readiness.status}`);
  if (spend) facts.push(`shopping forecast is ${formatCurrencyAmount(spend.currency, spend.amount)}`);
  return formatSection('Cooking', facts, 'Leave room for prep or shopping when the week is already tight.');
}

function summarizeFinanceForSecretary(finance: FinanceMeshContext | null): string {
  if (!finance) return '';
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  const renewal = extractRenewal(finance);
  if (!budget && !taxDeadline && !renewal) return '';

  const facts: string[] = [];
  if (budget) {
    const budgetHeadroom = formatBudgetRemainingFact(budget);
    const mixedCurrency = formatMixedCurrencyBudgetFact(budget);
    const recurringPressure = formatRecurringExpenseFact(budget);
    if (budgetHeadroom) facts.push(budgetHeadroom);
    if (mixedCurrency) facts.push(mixedCurrency);
    if (recurringPressure) facts.push(recurringPressure);
  }
  if (budget?.budgetMode) facts.push(`budget mode is ${budget.budgetMode}`);
  if (taxDeadline) facts.push(`tax deadline lands on ${taxDeadline.reminderDate}`);
  if (renewal) facts.push(`${renewal.plan} renews on ${renewal.currentPeriodEnd.slice(0, 10)}`);
  return formatSection('Finance', facts, 'Prioritize admin obligations before optional blocks.');
}

function summarizeContentForSecretary(content: ContentMeshContext | null): string {
  if (!content) return '';
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);

  const facts: string[] = [formatContentPlanStatusFact(content)];
  facts.push(...confirmedBlocks.slice(0, 3).map(formatConfirmedContentWorkBlockFact));
  facts.push(...deadlines.slice(0, 3).map(formatContentDeadlineFact));
  if (filming) facts.push(`proposed filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}; Secretary has not reserved it`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Only current Secretary-confirmed private work blocks carry scheduling authority; deadlines and recommendations remain advisory.');
}

function summarizeCookingForTraining(cooking: CookingMeshContext | null): string {
  if (!cooking) return '';
  const window = extractMealWindow(cooking);
  const spend = extractGroceryForecast(cooking);
  const fuelingSupport = extractFuelingSupportStatus(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  if (!window && spend == null && !fuelingSupport && !readiness) return '';

  const facts: string[] = [];
  if (window) {
    facts.push(
      window.missingDates.length > 0
        ? `${window.missingDates.length} day(s) are still missing meal coverage`
        : `meal coverage is already mapped for the week`,
    );
  }
  if (fuelingSupport) {
    facts.push(
      fuelingSupport.hardDatesMissingMeals.length > 0
        ? `fueling support is ${fuelingSupport.status} because hard training lacks meals on ${fuelingSupport.hardDatesMissingMeals.join(', ')}`
        : `fueling support is ${fuelingSupport.status}`,
    );
  }
  if (readiness) facts.push(`meal execution readiness is ${readiness.status}`);
  if (spend) facts.push(`shopping forecast is ${formatCurrencyAmount(spend.currency, spend.amount)}`);
  return formatSection('Cooking', facts, 'Adjust fueling expectations when meals are still thin.');
}

function summarizeSecretaryForTraining(secretary: SecretaryMeshContext | null): string {
  if (!secretary) return '';
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const focus = extractSecretaryFocus(secretary);
  const fragmentation = extractSecretaryFragmentation(secretary);
  const criticality = extractSecretaryMeetingCriticality(secretary);
  const deadlinePressure = extractSecretaryDeadlinePressure(secretary);
  if (!busy && !travel && !inbox && !focus && !fragmentation && !criticality && !deadlinePressure) return '';

  const facts: string[] = [];
  if (busy && busy.totalEvents > 0) facts.push(`calendar is busy on ${busy.dates.length} day(s) with ${busy.totalEvents} events`);
  if (travel && travel.dates.length > 0) facts.push(`travel is scheduled on ${travel.dates.join(', ')}`);
  if (focus) facts.push(`focus protection is currently best on ${focus.date}`);
  if (fragmentation?.fragmentedDayCount) facts.push(`calendar fragmentation hits ${fragmentation.fragmentedDayCount} day(s)`);
  if (criticality?.criticalEventCount) facts.push(`${criticality.criticalEventCount} critical meeting(s) need protecting`);
  if (inbox) {
    facts.push(
      inbox.overdueCount > 0 || inbox.dueTodayCount > 0
        ? `admin pressure shows ${inbox.overdueCount} overdue and ${inbox.dueTodayCount} due today`
        : `admin load is ${inbox.pendingCount} pending item(s) with ${inbox.dueThisWeekCount} due this week`,
    );
  }
  if (deadlinePressure?.mailUnreadTotal) facts.push(`mail pressure is ${deadlinePressure.mailUnreadTotal} unread`);
  return formatSection('Secretary', facts, 'Use this before locking long sessions, hard doubles, or high-friction training days.');
}

function summarizeFinanceForTraining(finance: FinanceMeshContext | null): string {
  if (!finance) return '';
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  if (!budget && !taxDeadline) return '';

  const facts: string[] = [];
  if (budget) {
    const budgetHeadroom = formatBudgetRemainingFact(budget);
    const mixedCurrency = formatMixedCurrencyBudgetFact(budget);
    const recurringPressure = formatRecurringExpenseFact(budget);
    if (budgetHeadroom) facts.push(budgetHeadroom);
    if (mixedCurrency) facts.push(mixedCurrency);
    if (recurringPressure) facts.push(recurringPressure);
  }
  if (budget?.trainingSpendMode) facts.push(`training spend mode is ${budget.trainingSpendMode}`);
  if (budget?.supplementMode) facts.push(`supplement mode is ${budget.supplementMode}`);
  if (taxDeadline) facts.push(`tax deadline lands on ${taxDeadline.reminderDate}`);
  return formatSection('Finance', facts, 'Keep travel, equipment, and supplement advice realistic.');
}

function summarizeContentForTraining(content: ContentMeshContext | null): string {
  if (!content) return '';
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);

  const facts: string[] = [formatContentPlanStatusFact(content)];
  facts.push(...confirmedBlocks.slice(0, 3).map(formatConfirmedContentWorkBlockFact));
  facts.push(...deadlines.slice(0, 3).map(formatContentDeadlineFact));
  if (filming) facts.push(`filming proposal points to ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Account for confirmed creator work separately from advisory targets and proposals.');
}

function summarizeTrainingForCooking(training: TrainingMeshContext | null): string {
  if (!training) return '';
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const fueling = extractFuelingRequirements(training);
  if (!recovery && !session && !fueling) return '';

  const facts: string[] = [];
  if (recovery) facts.push(`recovery is ${recovery.state}`);
  if (session) facts.push(`next session is ${session.title} on ${session.date}`);
  if (fueling) facts.push(`fueling support is ${fueling.supportLevel} with ${fueling.carbFocus} carb focus`);
  return formatSection('Training', facts, 'Use this to shape fueling, meal timing, and recovery meals.');
}

function summarizeSecretaryForCooking(secretary: SecretaryMeshContext | null): string {
  if (!secretary) return '';
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const portability = extractSecretaryTaskPortability(secretary);
  if (!busy && !travel && !focus && !inbox && !portability) return '';

  const facts: string[] = [];
  if (travel?.dates.length) facts.push(`travel is scheduled on ${travel.dates.join(', ')}`);
  if (busy?.dates.length) facts.push(`calendar is busy on ${busy.dates.length} day(s)`);
  if (focus) facts.push(`focus protection is currently best on ${focus.date}`);
  if (inbox && (inbox.overdueCount > 0 || inbox.dueTodayCount > 0)) {
    facts.push(`admin pressure shows ${inbox.overdueCount} overdue and ${inbox.dueTodayCount} due today`);
  }
  if (portability) facts.push(`${portability.portableCount} task(s) are portable and ${portability.fixedCount} are fixed`);
  return formatSection('Secretary', facts, 'Use this to place prep, shopping, and portable-meal days where the calendar can actually support them.');
}

function summarizeFinanceForCooking(finance: FinanceMeshContext | null): string {
  if (!finance) return '';
  const budget = extractBudget(finance);
  if (!budget) return '';
  const facts = compact([
    formatBudgetRemainingFact(budget),
    formatMixedCurrencyBudgetFact(budget),
    formatRecurringExpenseFact(budget),
    budget.groceryMode ? `grocery mode is ${budget.groceryMode}` : null,
  ]);
  return formatSection('Finance', facts, 'Keep recipe and shopping suggestions cost-aware.');
}

function summarizeContentForCooking(content: ContentMeshContext | null): string {
  if (!content) return '';
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);

  const facts: string[] = [formatContentPlanStatusFact(content)];
  facts.push(...confirmedBlocks.slice(0, 3).map(formatConfirmedContentWorkBlockFact));
  facts.push(...deadlines.slice(0, 3).map(formatContentDeadlineFact));
  if (filming) facts.push(`filming proposal points to ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Support confirmed private work blocks; do not treat deadlines or proposals as reserved work or publication.');
}

function summarizeTrainingForContent(
  training: TrainingMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): string {
  if (!training) return '';
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const story = extractTrainingContentStory(training);
  const hardDays = extractHardDayCount(training);
  if (!recovery && !session && !immovability && !story && hardDays == null) return '';

  const constrained = recovery?.state === 'critical'
    || recovery?.state === 'strained'
    || immovability?.level === 'high'
    || (hardDays != null && hardDays > 0);
  const fact = constrained
    ? 'training-derived capacity is constrained; keep production light and flexible'
    : 'training-derived capacity exists; preserve it when sizing production work';
  const guidance = disclosure === 'presentation_safe'
    ? 'Explicitly requested; underlying sessions and health facts withheld.'
    : 'Underlying sessions and health facts withheld.';
  return formatSection('Training', [fact], guidance);
}

function summarizeSecretaryForContent(
  secretary: SecretaryMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): string {
  if (!secretary) return '';
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const criticality = extractSecretaryMeetingCriticality(secretary);
  if (!busy && !travel && !focus && !inbox && !criticality) return '';

  const constrained = Boolean(
    busy?.dates.length
    || travel?.dates.length
    || focus
    || (inbox && (inbox.overdueCount > 0 || inbox.dueTodayCount > 0))
    || criticality?.criticalEventCount,
  );
  const fact = constrained
    ? 'schedule-derived availability is constrained; prefer short, movable production blocks'
    : 'schedule-derived availability does not currently add a production constraint';
  const guidance = disclosure === 'presentation_safe'
    ? 'Explicitly requested; calendar and inbox details withheld.'
    : 'Calendar and inbox details withheld.';
  return formatSection('Secretary', [fact], guidance);
}

function summarizeFinanceForContent(
  finance: FinanceMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): string {
  if (!finance) return '';
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  if (!budget && !taxDeadline) return '';

  const costConstrained = budget?.budgetMode === 'tight'
    || budget?.integrity === 'mixed_currency'
    || Boolean(taxDeadline);
  const mode = budget?.contentSpendMode && /^[a-z_]+$/i.test(budget.contentSpendMode)
    ? budget.contentSpendMode.replace(/_/g, ' ')
    : null;
  const fact = disclosure === 'presentation_safe' && mode
    ? `finance-derived production mode is ${mode}; avoid unrequested spend`
    : costConstrained
      ? 'finance-derived constraints favor a cost-conscious production plan'
      : 'finance-derived constraints do not justify additional production spend';
  const guidance = disclosure === 'presentation_safe'
    ? 'Explicitly requested; amounts, percentages, transactions, and tax details withheld.'
    : 'Amounts, percentages, transactions, and tax details withheld.';
  return formatSection('Finance', [fact], guidance);
}

function summarizeCookingForContent(
  cooking: CookingMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): string {
  if (!cooking) return '';
  const window = extractMealWindow(cooking);
  const support = extractFuelingSupportStatus(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  if (!window && !support && !readiness) return '';
  const constrained = Boolean(window?.missingDates.length)
    || support?.status === 'at_risk'
    || readiness?.status === 'partial';
  const fact = constrained
    ? 'meal-support-derived capacity is constrained; keep production low-friction'
    : 'meal-support-derived capacity does not currently add a production constraint';
  const guidance = disclosure === 'presentation_safe'
    ? 'Explicitly requested; meal, grocery, and nutrition details withheld.'
    : 'Meal, grocery, and nutrition details withheld.';
  return formatSection('Cooking', [fact], guidance);
}

function summarizeTrainingForFinance(training: TrainingMeshContext | null): string {
  if (!training) return '';
  const session = extractSessionPrescription(training);
  const fueling = extractFuelingRequirements(training);
  const hardDays = extractHardDayCount(training);
  if (!session && !fueling && hardDays == null) return '';

  const facts: string[] = [];
  if (session) facts.push(`next session is ${session.title} on ${session.date}`);
  if (fueling) facts.push(`fueling support is ${fueling.supportLevel}`);
  if (hardDays != null) facts.push(`${hardDays} hard day(s) are planned this week`);
  return formatSection('Training', facts, 'Use this before nudging equipment, supplement, or travel spend decisions.');
}

function summarizeCookingForFinance(cooking: CookingMeshContext | null): string {
  if (!cooking) return '';
  const spend = extractGroceryForecast(cooking);
  const window = extractMealWindow(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  const fuelingSupport = extractFuelingSupportStatus(cooking);
  if (spend == null && !window && !readiness && !fuelingSupport) return '';

  const facts: string[] = [];
  if (spend) facts.push(`shopping forecast is ${formatCurrencyAmount(spend.currency, spend.amount)}`);
  if (window && window.missingDates.length > 0) facts.push(`${window.missingDates.length} day(s) still need meals`);
  if (fuelingSupport) {
    facts.push(
      fuelingSupport.hardDatesMissingMeals.length > 0
        ? `fueling support is ${fuelingSupport.status} with ${fuelingSupport.hardDatesMissingMeals.length} hard training day(s) still exposed`
        : `fueling support is ${fuelingSupport.status}`,
    );
  }
  if (readiness) facts.push(`execution readiness is ${readiness.status}`);
  return formatSection('Cooking', facts, 'Food coverage should inform budget guidance, not sit outside it.');
}

function summarizeContentForFinance(content: ContentMeshContext | null): string {
  if (!content) return '';
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const nextExecution = extractNextContentExecution(content);
  const facts = compact([
    formatContentPlanStatusFact(content),
    ...confirmedBlocks.slice(0, 3).map(formatConfirmedContentWorkBlockFact),
    ...deadlines.slice(0, 3).map(formatContentDeadlineFact),
    nextExecution && isActionableContentExecution(nextExecution)
      ? formatNextContentExecutionFact(nextExecution)
      : null,
  ]);
  return formatSection('Content', facts, 'Factor confirmed private work into cost guidance while keeping deadlines and next moves advisory.');
}

function buildTrainingContractForSecretary(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const hardDays = extractHardDayCount(training);
  const completion = extractSafeTrainingCompletionSummary(training);
  // Surface the Content-deprioritization implication to Secretary
  // explicitly. When recovery is strained or critical, unconfirmed filming /
  // capture proposals are the natural first candidate for deferral. Confirmed
  // private Content blocks still require Secretary to reflow or cancel them.
  const recoveryCompromised = recovery?.state === 'strained' || recovery?.state === 'critical';
  return createContract({
    nonNegotiables: compact([
      immovability?.level === 'high' && session
        ? `Keep ${session.title} on ${session.date} protected before moving lower-value work.`
        : null,
      recovery?.state === 'critical'
        ? 'Reduce non-essential commitments — recovery is critical this week.'
        : recovery?.state === 'strained'
          ? 'Reduce avoidable day friction while recovery is strained.'
          : null,
    ]),
    preferredWindows: compact([
      session ? `Sequence the day around ${session.title} on ${session.date}.` : null,
    ]),
    fallbackIfDeferred: compact([
      hardDays != null && hardDays > 0
        ? `If the calendar compresses, protect the ${hardDays} hard training day(s) first and downgrade optional work.`
        : null,
      recoveryCompromised
        ? 'Unconfirmed filming and content-capture proposals are the first candidates for deferral while recovery stabilizes.'
        : null,
    ]),
    notes: compact([
      recovery ? `Recovery state: ${recovery.state}.` : null,
      completion ? formatSafeTrainingCompletionNote(completion) : null,
      extractCoachPhaseNote(training),
    ]),
  });
}

function buildCookingContractForSecretary(cooking: CookingMeshContext | null): PeerDecisionContract | null {
  if (!cooking) return null;
  const window = extractMealWindow(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  const support = extractFuelingSupportStatus(cooking);
  const spend = extractGroceryForecast(cooking);
  // When fueling is at risk for specific hard-session dates, tell
  // Secretary explicitly to protect day-before prep time. The loop
  // between Training (requests fueling) and Cooking (confirms support)
  // is already bidirectional, but without Secretary intervening on the
  // day-before prep slot, at-risk fueling just stays at-risk. This
  // gives Secretary a concrete time-shaping action rather than an
  // abstract advisory.
  const prepDateHints = support?.hardDatesMissingMeals
    .map(computePrepDayBeforeSession)
    .filter((value): value is string => typeof value === 'string')
    .slice(0, 5) ?? [];
  return createContract({
    nonNegotiables: compact([
      support?.hardDatesMissingMeals.length
        ? `Hard training day meal coverage is still missing on ${support.hardDatesMissingMeals.join(', ')}.`
        : null,
      prepDateHints.length > 0
        ? `Reserve 60\u201390 min of prep/cook time on ${prepDateHints.join(', ')} to cover the upcoming hard session(s).`
        : null,
    ]),
    preferredWindows: compact([
      window?.missingDates.length
        ? `Leave prep or shopping time for uncovered dates: ${window.missingDates.join(', ')}.`
        : null,
      readiness?.prepPressureDates.length
        ? `Prep pressure lands on ${readiness.prepPressureDates.join(', ')} — simplify food execution ahead of those dates.`
        : null,
    ]),
    fallbackIfDeferred: compact([
      readiness?.status === 'at_risk'
        ? 'If the week gets crowded, simplify meals instead of dropping fueling support entirely.'
        : null,
      readiness?.prepPressureDates.length
        ? 'If prep keeps slipping, replace high-effort meals on the pressured dates with simpler repeatable options.'
        : null,
    ]),
    notes: compact([
      spend ? `Shopping forecast: ${formatCurrencyAmount(spend.currency, spend.amount)}.` : null,
      readiness?.prepPressureDates.length
        ? `Meal execution pressure hits ${readiness.prepPressureDates.join(', ')}${readiness.highEffortMealCount > 0 ? ` with ${readiness.highEffortMealCount} high-effort meal(s)` : ''}.`
        : null,
    ]),
  });
}

/** Compute the YYYY-MM-DD one day before a given session date, used to
 *  reserve evening-before meal prep time when fueling is at risk. */
function computePrepDayBeforeSession(sessionDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(sessionDate);
  if (!match) return null;
  const utcSession = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utcSession)) return null;
  const dayBefore = new Date(utcSession - 24 * 60 * 60 * 1000);
  return dayBefore.toISOString().slice(0, 10);
}

function buildFinanceContractForSecretary(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  return createContract({
    nonNegotiables: compact([
      taxDeadline ? `Tax/admin follow-up is due by ${taxDeadline.reminderDate}.` : null,
      budget?.integrity === 'mixed_currency'
        ? `Budget posture is provisional for ${budget.month} because multiple currencies are mixed. Do not expand optional commitments until those amounts are normalized.`
        : null,
    ]),
    preferredWindows: compact([
      budget?.budgetMode ? `Keep optional blocks aligned with the ${budget.budgetMode} budget mode.` : null,
    ]),
    fallbackIfDeferred: compact([
      isVeryTightBudget(budget)
        ? 'Prefer admin completion and low-cost execution before adding optional commitments.'
        : null,
      budget?.recurringExpenseCount
        ? `Leave buffer for ${budget.recurringExpenseCount} recurring commitment(s) still likely this month before expanding the day.`
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: compact([
      budget ? buildBudgetContractNote(budget) : null,
      formatRecurringExpenseContractNote(budget),
    ]),
  });
}

function buildContentContractForSecretary(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: confirmedBlocks.map((block) => (
      `Keep the current Secretary-confirmed private ${formatContentWorkKind(block.workKind)} block for "${block.title}" from ${block.startsAt} to ${block.endsAt} unless Secretary reflows or cancels it.`
    )),
    preferredWindows: compact([
      ...deadlines.map((deadline) => (
        `Treat ${deadline.date} as an advisory target for "${deadline.title}", not as publication evidence or a calendar reservation.`
      )),
      filming
        ? `Review the proposed filming window on ${filming.date}${filming.window ? ` ${filming.window}` : ''}; it remains unreserved until Secretary confirms it.`
        : null,
      nextExecution?.scheduledDate
        && nextExecution.dateSemantics === 'recommended_work_date'
        && isActionableContentExecution(nextExecution)
        ? `Keep the proposed next Content move visible around its recommended work date ${nextExecution.scheduledDate}; it is not reserved.`
        : null,
    ]),
    fallbackIfDeferred: compact([
      confirmedBlocks.length > 0
        ? 'If a confirmed Content block conflicts with the day, ask Secretary to reflow it; do not silently move or cancel it.'
        : null,
      (filming || (nextExecution && isActionableContentExecution(nextExecution)))
        ? 'If the day compresses, move the proposal before displacing existing confirmed obligations.'
        : null,
    ]),
    notes: compact([
      formatContentPlanStatusFact(content),
      deadlines.length > 0 ? `${deadlines.length} Content deadline(s) remain target dates only.` : null,
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

function buildSecretaryContractForTraining(secretary: SecretaryMeshContext | null): PeerDecisionContract | null {
  if (!secretary) return null;
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const focus = extractSecretaryFocus(secretary);
  const fragmentation = extractSecretaryFragmentation(secretary);
  const criticality = extractSecretaryMeetingCriticality(secretary);
  return createContract({
    nonNegotiables: compact([
      travel?.dates.length ? `Travel is fixed on ${travel.dates.join(', ')}.` : null,
      busy?.dates.length ? `Busy calendar blocks already land on ${busy.dates.join(', ')}.` : null,
      criticality?.criticalEventCount ? `${criticality.criticalEventCount} critical meeting(s) are protected and should not be displaced by training.` : null,
    ]),
    preferredWindows: compact([
      focus ? `Use ${focus.date} as the best protected focus day.` : null,
      fragmentation?.dates.length
        ? `Prefer lower-friction sessions on fragmented calendar days (${fragmentation.dates.join(', ')}).`
        : null,
    ]),
    fallbackIfDeferred: compact([
      inbox && (inbox.overdueCount > 0 || inbox.dueTodayCount > 0)
        ? 'If training has to move, clear overdue or due-today admin before expanding optional work.'
        : null,
      busy?.dates.length || travel?.dates.length || fragmentation?.dates.length
        ? 'If availability changes, reflow the training plan and resync agenda ownership before showing the old schedule as final.'
        : null,
    ]),
    notes: compact([
      inbox ? `Admin pressure: ${inbox.overdueCount} overdue, ${inbox.dueTodayCount} due today.` : null,
      fragmentation ? `Calendar fragmentation: ${fragmentation.fragmentedDayCount} day(s), max ${fragmentation.maxEventsInDay} events in one day.` : null,
    ]),
  });
}

function buildCookingContractForTraining(cooking: CookingMeshContext | null): PeerDecisionContract | null {
  if (!cooking) return null;
  const support = extractFuelingSupportStatus(cooking);
  const window = extractMealWindow(cooking);
  const spend = extractGroceryForecast(cooking);
  return createContract({
    nonNegotiables: compact([
      support?.hardDatesMissingMeals.length
        ? `Hard-session fueling is still missing on ${support.hardDatesMissingMeals.join(', ')}.`
        : null,
    ]),
    preferredWindows: compact([
      window?.missingDates.length ? `Meal planning still needs ${window.missingDates.join(', ')}.` : null,
    ]),
    fallbackIfDeferred: compact([
      support?.status === 'at_risk'
        ? 'Reflow, lower, or shorten hard training before forcing unsupported fueling through another warning.'
        : null,
    ]),
    notes: compact([
      support?.hardDatesMissingMeals.length
        ? `Fueling gap dates are already named above; do not repeat generic fueling warnings in the coach rationale.`
        : null,
      spend ? `Shopping forecast: ${formatCurrencyAmount(spend.currency, spend.amount)}.` : null,
    ]),
  });
}

function buildFinanceContractForTraining(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  // Surface supplement-mode explicitly and give the training coach a
  // concrete "defer equipment / supplement asks" action when budget
  // is tight. The `trainingSpendMode` and `supplementMode` fields
  // both exist on the budget_remaining signal payload; historically
  // only `trainingSpendMode` flowed into the prompt.
  const veryTight = isVeryTightBudget(budget);
  return createContract({
    nonNegotiables: compact([
      taxDeadline ? `Tax/admin deadline hits ${taxDeadline.reminderDate}.` : null,
      veryTight
        ? 'Budget headroom is at or below 10% — defer supplement, gear, and equipment asks this cycle.'
        : null,
      budget?.integrity === 'mixed_currency'
        ? `Budget posture is provisional for ${budget.month} because currencies are mixed. Avoid recommending paid upgrades until finance data is normalized.`
        : null,
    ]),
    preferredWindows: compact([
      budget?.trainingSpendMode ? `Training spend mode is ${budget.trainingSpendMode}.` : null,
      budget?.supplementMode ? `Supplement spend mode is ${budget.supplementMode}.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight'
        ? 'Favor lower-friction or lower-cost training execution if the week is already tight.'
        : null,
      budget?.supplementMode === 'pause' || veryTight
        ? 'Prefer time-based progressions over paid equipment upgrades while supplement/gear spend is paused.'
        : null,
      budget?.recurringExpenseCount
        ? `Recurring commitments still likely this month (${budget.recurringExpenseCount}) should be treated as real spend pressure before adding optional training costs.`
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: compact([
      budget ? buildBudgetContractNote(budget) : null,
      formatRecurringExpenseContractNote(budget),
    ]),
  });
}

function buildContentContractForTraining(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: confirmedBlocks.map((block) => (
      `A current Secretary-confirmed private Content work block runs from ${block.startsAt} to ${block.endsAt}; preserve it or ask Secretary to reflow it.`
    )),
    preferredWindows: compact([
      ...deadlines.map((deadline) => `Content target for "${deadline.title}" is ${deadline.date}; it is advisory, not publication.`),
      filming ? `Filming proposal points to ${filming.date}${filming.window ? ` ${filming.window}` : ''}; no private block is confirmed by this recommendation.` : null,
      nextExecution && isActionableContentExecution(nextExecution) ? formatNextContentExecutionFact(nextExecution) + '.' : null,
    ]),
    fallbackIfDeferred: compact([
      filming ? 'Move the filming proposal before moving protected training, fueling, or Secretary-confirmed Content blocks.' : null,
      nextExecution && isActionableContentExecution(nextExecution)
        ? 'Avoid stacking hard doubles on a proposed Content work day unless Secretary confirms a private block and spare capacity.'
        : null,
    ]),
    notes: compact([
      formatContentPlanStatusFact(content),
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

function buildTrainingContractForCooking(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  return createContract({
    nonNegotiables: compact([
      immovability?.level === 'high' && session ? `${session.title} on ${session.date} is difficult to move.` : null,
    ]),
    preferredWindows: compact([
      session ? `Meal timing should support ${session.title} on ${session.date}.` : null,
    ]),
    fallbackIfDeferred: compact([
      session ? 'If prep slips, simplify meals but preserve the key session support.' : null,
    ]),
    notes: [],
  });
}

function buildSecretaryContractForCooking(secretary: SecretaryMeshContext | null): PeerDecisionContract | null {
  if (!secretary) return null;
  const focus = extractSecretaryFocus(secretary);
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  // Secretary's protected focus windows are binding on Cooking. Listed
  // only as a `preferredWindow` ("prep is easiest on X") the cooking
  // agent can freely ignore it and let prep land on the focus day. When
  // a focus block exists, the non-negotiable below makes it explicit
  // that prep work should NOT land on that date unless everywhere else
  // is fully blocked.
  return createContract({
    nonNegotiables: compact([
      travel?.dates.length ? `Travel lands on ${travel.dates.join(', ')}.` : null,
      focus ? `Do not place prep or shopping on ${focus.date} — Secretary is protecting it as a focus block.` : null,
    ]),
    preferredWindows: compact([
      busy?.dates.length ? `Avoid fragmented dates like ${busy.dates.join(', ')} for heavier prep.` : null,
    ]),
    fallbackIfDeferred: compact([
      busy?.dates.length ? 'If the calendar is fragmented, shift toward portable or lower-friction meal execution.' : null,
    ]),
    notes: [],
  });
}

function buildFinanceContractForCooking(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  // Derive an adaptive grocery-mode hint from budget headroom so
  // Cooking gets concrete spend-tier guidance instead of just the
  // binary "tight / flexible" budgetMode. The groceryMode field on
  // budget_remaining is authored by Finance; this just echoes it with
  // an actionable gate when headroom is very low.
  const veryTight = isVeryTightBudget(budget);
  const moderate = budget?.remainingRatio != null && budget.remainingRatio > 0.1 && budget.remainingRatio <= 0.5;
  return createContract({
    nonNegotiables: compact([
      veryTight
        ? 'Budget headroom is at or below 10% — anchor meal suggestions on cheap staples (rice, beans, eggs, seasonal veg).'
        : null,
      budget?.integrity === 'mixed_currency'
        ? `Budget posture is provisional for ${budget.month} because currencies are mixed. Default to conservative grocery suggestions until finance is normalized.`
        : null,
    ]),
    preferredWindows: compact([
      budget?.groceryMode ? `Grocery mode is ${budget.groceryMode}.` : null,
      moderate
        ? 'Budget is moderate (10\u201350% remaining) — balance staples with one or two targeted premium items per week.'
        : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight' ? 'Favor repeatable lower-cost staples before novelty recipes.' : null,
      budget?.recurringExpenseCount
        ? `Recurring commitments still likely this month (${budget.recurringExpenseCount}) should reduce grocery ambition before removing meal coverage.`
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: compact([
      budget ? buildBudgetContractNote(budget) : null,
      formatRecurringExpenseContractNote(budget),
    ]),
  });
}

function buildContentContractForCooking(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: confirmedBlocks.map((block) => (
      `A current Secretary-confirmed private Content work block runs from ${block.startsAt} to ${block.endsAt}; keep meal support compatible with it.`
    )),
    preferredWindows: deadlines.map((deadline) => (
      `Content target for "${deadline.title}" is ${deadline.date}; it is advisory and does not reserve work or publication time.`
    )),
    fallbackIfDeferred: compact([
      confirmedBlocks.length > 0 ? 'Keep meals lower-friction around confirmed private Content work blocks.' : null,
      confirmedBlocks.length === 0 && nextExecution && isActionableContentExecution(nextExecution)
        ? 'Treat the next Content move as a proposal when sizing food prep; no private work block is confirmed.'
        : null,
    ]),
    notes: compact([
      formatContentPlanStatusFact(content),
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

function buildTrainingContractForContent(
  training: TrainingMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const recoveryCritical = recovery?.state === 'critical';
  const recoveryStrained = recovery?.state === 'strained';
  const capacityConstrained = recoveryCritical || recoveryStrained || immovability?.level === 'high';
  return createContract({
    nonNegotiables: compact([
      capacityConstrained ? 'Keep production light because training-derived capacity is constrained.' : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      capacityConstrained ? 'Defer capture before asking the Training skill to absorb creator workload.' : null,
    ]),
    notes: compact([
      session || recovery || immovability
        ? `${disclosure === 'presentation_safe' ? 'Explicitly requested' : 'Default coarse'} training constraint; underlying session and health details withheld.`
        : null,
    ]),
  });
}

function buildSecretaryContractForContent(
  secretary: SecretaryMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): PeerDecisionContract | null {
  if (!secretary) return null;
  const busy = extractSecretaryBusy(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const constrained = Boolean(busy?.dates.length || focus || (inbox && inbox.overdueCount > 0));
  return createContract({
    nonNegotiables: compact([
      constrained ? 'Respect existing schedule and focus protection without exposing calendar details.' : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      constrained ? 'Use shorter, movable production blocks or request a Secretary scheduling preview.' : null,
    ]),
    notes: compact([
      constrained
        ? `${disclosure === 'presentation_safe' ? 'Explicitly requested' : 'Default coarse'} availability constraint; calendar and inbox details withheld.`
        : null,
    ]),
  });
}

function buildFinanceContractForContent(
  finance: FinanceMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  const constrained = budget?.budgetMode === 'tight' || budget?.integrity === 'mixed_currency';
  return createContract({
    nonNegotiables: compact([
      constrained ? 'Do not assume room for paid production upgrades.' : null,
    ]),
    preferredWindows: compact([
      disclosure === 'presentation_safe' && budget?.contentSpendMode
        ? `Use the presentation-safe content spend mode: ${budget.contentSpendMode.replace(/_/g, ' ')}.`
        : null,
    ]),
    fallbackIfDeferred: compact([
      constrained ? 'Prefer lower-friction production that does not add spend.' : null,
    ]),
    budgetMode: null,
    notes: compact([
      budget ? 'Underlying amounts, percentages, currencies, periods, transactions, and tax details withheld.' : null,
    ]),
  });
}

function buildCookingContractForContent(
  cooking: CookingMeshContext | null,
  disclosure: ContentCrossSkillContextPolicy['disclosure'],
): PeerDecisionContract | null {
  if (!cooking) return null;
  const support = extractFuelingSupportStatus(cooking);
  const window = extractMealWindow(cooking);
  const constrained = support?.status === 'at_risk' || Boolean(window?.missingDates.length);
  return createContract({
    nonNegotiables: [],
    preferredWindows: [],
    fallbackIfDeferred: compact([
      constrained ? 'Keep production low-friction so it does not displace meal support.' : null,
    ]),
    notes: compact([
      constrained
        ? `${disclosure === 'presentation_safe' ? 'Explicitly requested' : 'Default coarse'} meal-support constraint; meal gaps and dates withheld.`
        : null,
    ]),
  });
}

function buildTrainingContractForFinance(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const session = extractSessionPrescription(training);
  return createContract({
    nonNegotiables: compact([
      session ? `Training still needs ${session.title} on ${session.date}.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      session ? 'Budget advice should preserve key-session execution before optional upgrades.' : null,
    ]),
    notes: [],
  });
}

function buildCookingContractForFinance(cooking: CookingMeshContext | null): PeerDecisionContract | null {
  if (!cooking) return null;
  const spend = extractGroceryForecast(cooking);
  const support = extractFuelingSupportStatus(cooking);
  return createContract({
    nonNegotiables: compact([
      support?.hardDatesMissingMeals.length ? 'Food coverage is still constraining hard training support.' : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      spend ? 'Budget guidance should stay anchored to the active grocery plan instead of assuming zero meal cost.' : null,
    ]),
    notes: compact([spend ? `Shopping forecast: ${formatCurrencyAmount(spend.currency, spend.amount)}.` : null]),
  });
}

function buildContentContractForFinance(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const deadlines = extractContentDeadlines(content);
  const confirmedBlocks = extractConfirmedContentWorkBlocks(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: confirmedBlocks.map((block) => (
      `A current Secretary-confirmed private Content work block runs from ${block.startsAt} to ${block.endsAt}; preserve it in cost guidance unless Secretary reflows it.`
    )),
    preferredWindows: deadlines.map((deadline) => (
      `Content target for "${deadline.title}" is ${deadline.date}; treat it as advisory rather than a delivery or publication commitment.`
    )),
    fallbackIfDeferred: compact([
      confirmedBlocks.length > 0 ? 'Cost guidance should respect confirmed private Content work without assuming publication.' : null,
      confirmedBlocks.length === 0 && nextExecution && isActionableContentExecution(nextExecution)
        ? 'Treat the next Content move as a proposal; do not infer reserved time or a delivery obligation.'
        : null,
    ]),
    notes: compact([
      formatContentPlanStatusFact(content),
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

interface SafeTrainingCompletionSummary {
  completionState: 'completed' | 'partial' | 'skipped';
  hasDiscomfort: boolean;
  hasReadiness: boolean;
  skippedReasonCode: string | null;
}

const SAFE_TRAINING_SKIP_REASON_CODES = new Set([
  'not_enough_time',
  'fatigue',
  'soreness',
  'pain',
  'equipment',
  'schedule_conflict',
  'motivation',
  'other',
]);

/**
 * Defense-in-depth allowlist for a cross-skill health signal. Ignore every
 * unrecognized producer field so raw pain values, locations, notes, and free
 * text can never enter Secretary prompt context.
 */
function extractSafeTrainingCompletionSummary(
  training: TrainingMeshContext,
): SafeTrainingCompletionSummary | null {
  const signal = training.derivedSignals.find(
    (entry) => entry.signalType === 'training_completion_summary',
  );
  const rawState = signal?.payload.completionState;
  if (rawState !== 'completed' && rawState !== 'partial' && rawState !== 'skipped') return null;
  const rawReason = signal?.payload.skippedReasonCode;
  const skippedReasonCode = rawState === 'skipped'
    && typeof rawReason === 'string'
    && SAFE_TRAINING_SKIP_REASON_CODES.has(rawReason)
    ? rawReason
    : null;
  return {
    completionState: rawState,
    hasDiscomfort: signal?.payload.hasDiscomfort === true,
    hasReadiness: signal?.payload.hasReadiness === true,
    skippedReasonCode,
  };
}

function formatSafeTrainingCompletionNote(completion: SafeTrainingCompletionSummary): string {
  const facts = [`Latest training disposition: ${completion.completionState}`];
  if (completion.hasDiscomfort) facts.push('discomfort reported');
  if (completion.hasReadiness) facts.push('readiness feedback recorded');
  if (completion.skippedReasonCode) facts.push(`skip reason code: ${completion.skippedReasonCode}`);
  return `${facts.join('; ')}.`;
}

function extractRecoveryState(training: TrainingMeshContext): { state: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'recovery_state');
  const state = signal?.payload.state;
  return typeof state === 'string' ? { state } : null;
}

/** Format the persisted coach phase memory as a short note line for
 *  peer-domain prompts (Secretary, Content, Cooking). Returns null when
 *  no phase memory has been written yet. */
function extractCoachPhaseNote(training: TrainingMeshContext): string | null {
  const memory = training.coachPhaseMemory;
  if (!memory) return null;
  const prefix = memory.weekInPhase && memory.phaseTotalWeeks
    ? `Training phase: ${memory.phase} (week ${memory.weekInPhase}/${memory.phaseTotalWeeks})`
    : `Training phase: ${memory.phase}`;
  const extras: string[] = [];
  if (memory.adherenceTrend) extras.push(`adherence ${memory.adherenceTrend}`);
  if (memory.activeConcern) extras.push(`concern: ${memory.activeConcern}`);
  if (memory.nextExpectedShift) extras.push(`next shift: ${memory.nextExpectedShift}`);
  return extras.length > 0 ? `${prefix} — ${extras.join('; ')}.` : `${prefix}.`;
}

function extractSessionPrescription(training: TrainingMeshContext): { title: string; date: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'session_prescription');
  const title = signal?.payload.title;
  const date = signal?.payload.date;
  if (typeof title !== 'string' || typeof date !== 'string') return null;
  return { title, date };
}

function extractSessionImmovability(training: TrainingMeshContext): { title: string; level: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'session_immovability');
  const title = signal?.payload.title;
  const level = signal?.payload.level;
  if (typeof title !== 'string' || typeof level !== 'string') return null;
  return { title, level };
}

function extractFuelingRequirements(
  training: TrainingMeshContext,
): { supportLevel: string; carbFocus: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'fueling_requirements');
  const supportLevel = signal?.payload.supportLevel;
  const carbFocus = signal?.payload.carbFocus;
  if (typeof supportLevel !== 'string' || typeof carbFocus !== 'string') return null;
  return { supportLevel, carbFocus };
}

function extractTrainingContentStory(
  training: TrainingMeshContext,
): { angle: string; title: string; date: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'content_capture_opportunity');
  const angle = signal?.payload.angle;
  const title = signal?.payload.title;
  const date = signal?.payload.date;
  if (typeof angle !== 'string' || typeof title !== 'string' || typeof date !== 'string') return null;
  return { angle, title, date };
}

function extractSecretaryBusy(secretary: SecretaryMeshContext): { dates: string[]; totalEvents: number } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'calendar_busy_blocks');
  const dates = Array.isArray(signal?.payload.dates)
    ? signal.payload.dates.filter((value): value is string => typeof value === 'string')
    : [];
  const totalEvents = typeof signal?.payload.totalEvents === 'number' ? signal.payload.totalEvents : 0;
  if (dates.length === 0 && totalEvents === 0) return null;
  return { dates, totalEvents };
}

function extractSecretaryTravel(secretary: SecretaryMeshContext): { dates: string[] } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'travel_window');
  const dates = Array.isArray(signal?.payload.dates)
    ? signal.payload.dates.filter((value): value is string => typeof value === 'string')
    : [];
  return dates.length > 0 ? { dates } : null;
}

function extractSecretaryInboxPressure(
  secretary: SecretaryMeshContext,
): { overdueCount: number; dueTodayCount: number; dueThisWeekCount: number; pendingCount: number } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'inbox_pressure');
  if (!signal) return null;
  return {
    overdueCount: typeof signal.payload.overdueCount === 'number' ? signal.payload.overdueCount : 0,
    dueTodayCount: typeof signal.payload.dueTodayCount === 'number' ? signal.payload.dueTodayCount : 0,
    dueThisWeekCount: typeof signal.payload.dueThisWeekCount === 'number' ? signal.payload.dueThisWeekCount : 0,
    pendingCount: typeof signal.payload.pendingCount === 'number' ? signal.payload.pendingCount : 0,
  };
}

function extractSecretaryFocus(secretary: SecretaryMeshContext): { date: string } | null {
  return typeof secretary.focusBlock?.date === 'string' ? { date: secretary.focusBlock.date } : null;
}

function extractHardDayCount(training: TrainingMeshContext): number | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'training_load_forecast');
  const value = signal?.payload.hardSessionCount;
  return typeof value === 'number' ? value : null;
}

function extractMealWindow(cooking: CookingMeshContext): { coveredDays: string[]; missingDates: string[] } | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'meal_plan_window');
  const coveredDays = Array.isArray(signal?.payload.coveredDays)
    ? signal.payload.coveredDays.filter((value): value is string => typeof value === 'string')
    : [];
  const missingDates = Array.isArray(signal?.payload.missingDates)
    ? signal.payload.missingDates.filter((value): value is string => typeof value === 'string')
    : [];
  if (coveredDays.length === 0 && missingDates.length === 0) return null;
  return { coveredDays, missingDates };
}

function extractGroceryForecast(cooking: CookingMeshContext): { amount: number; currency: string } | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'grocery_spend_forecast');
  const amount = typeof signal?.payload.estimatedSpend === 'number'
    ? signal.payload.estimatedSpend
    : typeof signal?.payload.estimatedSpendBrl === 'number'
      ? signal.payload.estimatedSpendBrl
      : null;
  const currency = typeof signal?.payload.currency === 'string' && signal.payload.currency.trim().length > 0
    ? signal.payload.currency.toUpperCase()
    : 'BRL';
  return typeof amount === 'number' ? { amount, currency } : null;
}

function extractFuelingSupportStatus(
  cooking: CookingMeshContext,
): { status: string; hardDatesMissingMeals: string[] } | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'fueling_support_status');
  const status = signal?.payload.status;
  const hardDatesMissingMeals = Array.isArray(signal?.payload.hardDatesMissingMeals)
    ? signal.payload.hardDatesMissingMeals.filter((value): value is string => typeof value === 'string')
    : [];
  if (typeof status !== 'string') return null;
  return { status, hardDatesMissingMeals };
}

function extractMealExecutionReadiness(
  cooking: CookingMeshContext,
): {
  status: string;
  constrainedMealDates: string[];
  prepPressureDates: string[];
  manualMealCount: number;
  highEffortMealCount: number;
} | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'meal_execution_readiness');
  const status = signal?.payload.status;
  if (typeof status !== 'string') return null;
  return {
    status,
    constrainedMealDates: Array.isArray(signal?.payload.constrainedMealDates)
      ? signal.payload.constrainedMealDates.filter((value): value is string => typeof value === 'string')
      : [],
    prepPressureDates: Array.isArray(signal?.payload.prepPressureDates)
      ? signal.payload.prepPressureDates.filter((value): value is string => typeof value === 'string')
      : [],
    manualMealCount: typeof signal?.payload.manualMealCount === 'number' ? signal.payload.manualMealCount : 0,
    highEffortMealCount: typeof signal?.payload.highEffortMealCount === 'number' ? signal.payload.highEffortMealCount : 0,
  };
}

function extractSecretaryFragmentation(
  secretary: SecretaryMeshContext,
): { dates: string[]; fragmentedDayCount: number; maxEventsInDay: number } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'calendar_fragmentation');
  const dates = Array.isArray(signal?.payload.dates)
    ? signal.payload.dates.filter((value): value is string => typeof value === 'string')
    : [];
  const fragmentedDayCount = typeof signal?.payload.fragmentedDayCount === 'number'
    ? signal.payload.fragmentedDayCount
    : dates.length;
  const maxEventsInDay = typeof signal?.payload.maxEventsInDay === 'number'
    ? signal.payload.maxEventsInDay
    : 0;
  if (dates.length === 0 && fragmentedDayCount === 0 && maxEventsInDay === 0) return null;
  return { dates, fragmentedDayCount, maxEventsInDay };
}

function extractSecretaryDeadlinePressure(
  secretary: SecretaryMeshContext,
): { level: string; mailUnreadTotal: number } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'deadline_pressure');
  const level = signal?.payload.level;
  if (typeof level !== 'string') return null;
  return {
    level,
    mailUnreadTotal: typeof signal?.payload.mailUnreadTotal === 'number' ? signal.payload.mailUnreadTotal : 0,
  };
}

function extractSecretaryMeetingCriticality(
  secretary: SecretaryMeshContext,
): { criticalEventCount: number; dates: string[] } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'meeting_criticality');
  if (!signal) return null;
  const criticalEventCount = typeof signal.payload.criticalEventCount === 'number'
    ? signal.payload.criticalEventCount
    : 0;
  const dates = Array.isArray(signal.payload.dates)
    ? signal.payload.dates.filter((value): value is string => typeof value === 'string')
    : [];
  if (criticalEventCount === 0 && dates.length === 0) return null;
  return { criticalEventCount, dates };
}

function extractSecretaryTaskPortability(
  secretary: SecretaryMeshContext,
): { portableCount: number; fixedCount: number; portableRatio: number } | null {
  const signal = secretary.derivedSignals.find((entry) => entry.signalType === 'task_portability');
  if (!signal) return null;
  const portableCount = typeof signal.payload.portableCount === 'number' ? signal.payload.portableCount : 0;
  const fixedCount = typeof signal.payload.fixedCount === 'number' ? signal.payload.fixedCount : 0;
  const portableRatio = typeof signal.payload.portableRatio === 'number' ? signal.payload.portableRatio : 0;
  if (portableCount === 0 && fixedCount === 0) return null;
  return { portableCount, fixedCount, portableRatio };
}

function extractBudget(finance: FinanceMeshContext): {
  month: string;
  remainingRatio: number | null;
  budgetMode: string | null;
  groceryMode: string | null;
  trainingSpendMode: string | null;
  contentSpendMode: string | null;
  supplementMode: string | null;
  integrity: string | null;
  basisCurrency: string | null;
  recurringExpenseEstimate: number;
  recurringExpenseCount: number;
  notes: string[];
} | null {
  if (
    finance.monthlySummary.transactionCount === 0
    && finance.monthlySummary.totalIncome === 0
    && finance.monthlySummary.totalExpenses === 0
    && finance.monthlySummary.totalDeductions === 0
  ) {
    return null;
  }
  const signal = finance.derivedSignals.find((entry) => entry.signalType === 'budget_remaining');
  const month = typeof signal?.payload.month === 'string'
    ? signal.payload.month
    : finance.budgetView.month;
  const remainingRatio = typeof signal?.payload.projectedRemainingRatio === 'number'
    ? signal.payload.projectedRemainingRatio
    : typeof signal?.payload.remainingRatio === 'number'
      ? signal.payload.remainingRatio
      : finance.budgetView.projectedRemainingRatio ?? finance.budgetView.currentRemainingRatio;
  const integrity = typeof signal?.payload.integrity === 'string'
    ? signal.payload.integrity
    : finance.budgetView.integrity;
  if (typeof month !== 'string') return null;
  return {
    month,
    remainingRatio,
    budgetMode: typeof signal?.payload.budgetMode === 'string' ? signal.payload.budgetMode : null,
    groceryMode: typeof signal?.payload.groceryMode === 'string' ? signal.payload.groceryMode : null,
    trainingSpendMode: typeof signal?.payload.trainingSpendMode === 'string' ? signal.payload.trainingSpendMode : null,
    contentSpendMode: typeof signal?.payload.contentSpendMode === 'string' ? signal.payload.contentSpendMode : null,
    supplementMode: typeof signal?.payload.supplementMode === 'string' ? signal.payload.supplementMode : null,
    integrity,
    basisCurrency: typeof signal?.payload.basisCurrency === 'string'
      ? signal.payload.basisCurrency
      : finance.budgetView.basisCurrency,
    recurringExpenseEstimate: typeof signal?.payload.recurringExpenseEstimate === 'number'
      ? signal.payload.recurringExpenseEstimate
      : finance.budgetView.recurringExpenseEstimate,
    recurringExpenseCount: typeof signal?.payload.recurringExpenseCount === 'number'
      ? signal.payload.recurringExpenseCount
      : finance.budgetView.recurringExpenseCount,
    notes: finance.budgetView.notes,
  };
}

function extractTaxDeadline(finance: FinanceMeshContext): { reminderDate: string } | null {
  const signal = finance.derivedSignals.find((entry) => entry.signalType === 'tax_deadline');
  const reminderDate = signal?.payload.reminderDate;
  return typeof reminderDate === 'string' ? { reminderDate } : null;
}

function extractRenewal(finance: FinanceMeshContext): { plan: string; currentPeriodEnd: string } | null {
  const signal = finance.derivedSignals.find((entry) => entry.signalType === 'subscription_renewal_due');
  const plan = signal?.payload.plan;
  const currentPeriodEnd = signal?.payload.currentPeriodEnd;
  if (typeof plan !== 'string' || typeof currentPeriodEnd !== 'string') return null;
  return { plan, currentPeriodEnd };
}

function extractContentDeadlines(content: ContentMeshContext): ContentMeshContext['deadlines'] {
  return Array.isArray(content.deadlines)
    ? content.deadlines.filter((deadline) => deadline.semantics === 'target_date_not_publication')
    : [];
}

function extractConfirmedContentWorkBlocks(
  content: ContentMeshContext,
): ContentMeshContext['workSchedule']['confirmedBlocks'] {
  if (!canConsumeConfirmedContentWorkSchedule(content.workSchedule)) return [];
  const blocks = content.workSchedule?.confirmedBlocks;
  return Array.isArray(blocks)
    ? blocks.filter((block) => (
      block.authority === 'secretary'
      && block.authorityStatus === 'current'
      && block.semantics === 'private_work_session'
      && (
        block.state === 'scheduled'
        || block.state === 'provider_synced'
        || block.state === 'sync_failed'
      )
    ))
    : [];
}

function formatContentPlanStatusFact(content: ContentMeshContext): string {
  const workSchedule = content.workSchedule;
  if (!workSchedule) {
    return 'Content schedule authority and plan status are unavailable';
  }
  switch (workSchedule.planStatus) {
    case 'confirmed':
      {
        const confirmedBlockCount = extractConfirmedContentWorkBlocks(content).length;
        return confirmedBlockCount > 0
          ? `Content plan status is confirmed under current Secretary authority with ${confirmedBlockCount} private work block(s)`
          : 'Content plan status needs review: a confirmed state was reported without a current Secretary-confirmed private work block';
      }
    case 'proposed':
      return 'Content plan status is proposed; Secretary has not confirmed a private work block';
    case 'unplanned':
      return 'Content plan status is unplanned; current Secretary authority reports zero confirmed private work blocks';
    case 'partial':
      return `Content plan status is partial because Secretary authority is partially unavailable (${workSchedule.attentionCount} block(s) need attention)`;
    case 'unavailable':
    default:
      return 'Content plan status is unavailable because Secretary scheduling authority could not be read';
  }
}

function formatContentDeadlineFact(deadline: ContentMeshContext['deadlines'][number]): string {
  return `"${deadline.title}" has an advisory target date on ${deadline.date}, not a publication event or calendar reservation`;
}

function formatConfirmedContentWorkBlockFact(
  block: ContentMeshContext['workSchedule']['confirmedBlocks'][number],
): string {
  const providerAttention = block.state === 'sync_failed'
    ? '; the private block remains confirmed while provider sync needs attention'
    : '';
  return `Secretary confirms a private ${formatContentWorkKind(block.workKind)} block for "${block.title}" from ${block.startsAt} to ${block.endsAt}${providerAttention}; it does not publish content`;
}

function formatContentWorkKind(
  workKind: ContentMeshContext['workSchedule']['confirmedBlocks'][number]['workKind'],
): string {
  switch (workKind) {
    case 'record': return 'filming';
    case 'edit': return 'editing';
    case 'write': return 'writing';
    case 'revise': return 'revision';
    case 'publish_prep': return 'publication-preparation';
    default: return workKind.replace(/_/g, ' ');
  }
}

function extractFilmingRecommendation(content: ContentMeshContext): { date: string; window: string | null } | null {
  const recommendation = content.filmingRecommendation;
  if (!recommendation?.date) return null;
  const window = recommendation.blockStart && recommendation.blockEnd
    ? `${recommendation.blockStart.slice(11, 16)}-${recommendation.blockEnd.slice(11, 16)}`
    : null;
  return { date: recommendation.date, window };
}

function extractNextContentExecution(content: ContentMeshContext): {
  mode: string;
  title: string;
  summary: string;
  scheduledDate: string | null;
  dateSemantics: 'private_deadline' | 'recommended_work_date' | 'none';
  calendarConfirmed: boolean;
  confidence: string;
} | null {
  const nextExecution = content.nextExecution;
  if (!nextExecution || typeof nextExecution.mode !== 'string' || typeof nextExecution.title !== 'string') {
    return null;
  }

  return {
    mode: nextExecution.mode,
    title: nextExecution.title,
    summary: nextExecution.summary,
    scheduledDate: nextExecution.scheduledDate ?? null,
    dateSemantics: nextExecution.dateSemantics ?? 'none',
    calendarConfirmed: nextExecution.calendarConfirmed === true,
    confidence: nextExecution.confidence,
  };
}

function isActionableContentExecution(
  execution: ReturnType<typeof extractNextContentExecution>,
): boolean {
  if (!execution) return false;
  return execution.mode !== 'discovery';
}

function formatNextContentExecutionFact(
  execution: NonNullable<ReturnType<typeof extractNextContentExecution>>,
): string {
  const dateContext = formatNextContentExecutionDateContext(execution);
  switch (execution.mode) {
    case 'publish_ready':
      return `a publication candidate for "${execution.title}" is ready for review${dateContext}`;
    case 'script_ready':
      return `proposed next Content move is to work from the ready script "${execution.title}"${dateContext}`;
    case 'reaction_window':
      return `proposed next Content move is a reaction window for "${execution.title}"${dateContext}`;
    case 'film_window':
      return `proposed next Content move is to capture "${execution.title}"${dateContext}`;
    default:
      return `proposed next Content move is "${execution.title}"${dateContext}`;
  }
}

function formatNextContentExecutionDateContext(
  execution: NonNullable<ReturnType<typeof extractNextContentExecution>>,
): string {
  if (!execution.scheduledDate || execution.dateSemantics === 'none') {
    return '; this hint does not confirm calendar time';
  }
  if (execution.dateSemantics === 'private_deadline') {
    return `; its private advisory deadline is ${execution.scheduledDate}, not a reservation or publication event`;
  }
  return `; its recommended work date is ${execution.scheduledDate}, but Secretary has not confirmed a private block`;
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function formatBudgetRemainingFact(budget: ReturnType<typeof extractBudget>): string | null {
  if (!budget) return null;
  if (budget.remainingRatio == null) {
    return budget.integrity === 'no_income'
      ? `budget headroom is still provisional for ${budget.month} because no income is logged`
      : null;
  }
  return `projected budget remaining is ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}`;
}

function formatMixedCurrencyBudgetFact(budget: ReturnType<typeof extractBudget>): string | null {
  if (!budget || budget.integrity !== 'mixed_currency') return null;
  const currencies = budget.notes.find((note) => note.toLowerCase().includes('mixed currencies'))
    ? null
    : budget.basisCurrency;
  return currencies
    ? `budget mixes currencies this month, so only ${currencies} spend is being treated as reliable`
    : 'budget mixes currencies this month, so headroom is only provisional until amounts are normalized';
}

function formatRecurringExpenseFact(budget: ReturnType<typeof extractBudget>): string | null {
  if (!budget || budget.recurringExpenseEstimate <= 0 || !budget.basisCurrency) return null;
  return `recurring commitments still likely this month add ${formatCurrencyAmount(budget.basisCurrency, budget.recurringExpenseEstimate)} of pressure across ${budget.recurringExpenseCount} item(s)`;
}

function buildBudgetContractNote(budget: ReturnType<typeof extractBudget>): string | null {
  if (!budget) return null;
  if (budget.remainingRatio != null) {
    return `Projected budget remaining: ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}.`;
  }
  if (budget.integrity === 'mixed_currency') {
    return `Budget headroom is provisional for ${budget.month} because currencies are mixed.`;
  }
  if (budget.integrity === 'no_income') {
    return `Budget headroom is provisional for ${budget.month} because no income is logged yet.`;
  }
  return null;
}

function formatRecurringExpenseContractNote(budget: ReturnType<typeof extractBudget>): string | null {
  if (!budget || budget.recurringExpenseEstimate <= 0 || !budget.basisCurrency) return null;
  return `Recurring commitments still likely this month: ${formatCurrencyAmount(budget.basisCurrency, budget.recurringExpenseEstimate)} across ${budget.recurringExpenseCount} item(s).`;
}

function isVeryTightBudget(budget: ReturnType<typeof extractBudget>): boolean {
  return Boolean(budget?.remainingRatio != null && budget.remainingRatio <= 0.1);
}

function compactContracts(
  contracts: Partial<Record<PeerSkill, PeerDecisionContract | null>>,
): SharedDecisionContracts {
  return Object.fromEntries(
    Object.entries(contracts).filter(([, contract]) => hasContractContent(contract)),
  ) as SharedDecisionContracts;
}

function createContract(contract: PeerDecisionContract): PeerDecisionContract | null {
  const normalized: PeerDecisionContract = {
    ...contract,
    nonNegotiables: dedupeStrings(contract.nonNegotiables),
    preferredWindows: dedupeStrings(contract.preferredWindows),
    fallbackIfDeferred: dedupeStrings(contract.fallbackIfDeferred),
    notes: dedupeStrings(contract.notes),
  };
  return hasContractContent(normalized) ? normalized : null;
}

function hasContractContent(contract: PeerDecisionContract | null | undefined): contract is PeerDecisionContract {
  if (!contract) return false;
  return contract.nonNegotiables.length > 0
    || contract.preferredWindows.length > 0
    || contract.fallbackIfDeferred.length > 0
    || contract.notes.length > 0
    || Boolean(contract.budgetMode);
}

function formatSection(label: string, facts: string[], tail: string): string {
  return `${label}: ${dedupeStrings(facts).join('; ')}. ${tail}`;
}
