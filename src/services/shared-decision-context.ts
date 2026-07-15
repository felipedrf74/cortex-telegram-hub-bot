// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import {
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
type SharedContextFreshness = 'active' | 'expiring' | 'stale' | 'unknown';

export interface PeerDecisionContract {
  nonNegotiables: string[];
  preferredWindows: string[];
  fallbackIfDeferred: string[];
  budgetMode?: string | null;
  publishDeadline?: string | null;
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

export async function buildSharedDecisionContext(domain: DomainName, userId: number, tenantId?: number): Promise<string> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId, tenantId);
  return artifacts.text;
}

export async function buildSharedDecisionContracts(domain: DomainName, userId: number, tenantId?: number): Promise<SharedDecisionContracts> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId, tenantId);
  return artifacts.contracts;
}

async function buildSharedDecisionArtifacts(
  domain: DomainName,
  userId: number,
  tenantId?: number,
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

  const cacheKey = `${resolvedTenantId}:${userId}:${domain}`;
  const cached = _sharedDecisionContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return {
      text: cached.text,
      contracts: cached.contracts,
    };
  }

  const rawBundle = await readRelevantPeerContexts(domain, userId, resolvedTenantId);
  const { bundle, staleSignals } = filterStaleBundle(rawBundle);
  const sections = buildSectionsForDomain(domain, bundle);
  const sourceLines = buildSourceAttributionLines(bundle);
  const staleLines = buildStaleContextLines(staleSignals);
  const text = sections.length > 0 || staleLines.length > 0
    ? [
      `<shared_decision_context domain="${domain}">`,
      `<context_scope tenant_id="${resolvedTenantId}" user_id="${userId}" visibility="user_private" cache_ttl_ms="${CONTEXT_TTL_MS}" />`,
      '<source_attribution>',
      ...(sourceLines.length > 0 ? sourceLines : ['- none: no fresh peer-skill signals available']),
      '</source_attribution>',
      '<skill_ownership_boundaries>',
      ...buildSkillOwnershipLines(domain),
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
  const contracts = buildContractsForDomain(domain, bundle);

  _sharedDecisionContextCache.set(cacheKey, {
    text,
    contracts,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  });
  return { text, contracts };
}

async function readRelevantPeerContexts(domain: DomainName, userId: number, tenantId: number): Promise<MeshBundle> {
  const needsTraining = domain !== 'triathlon';
  const needsCooking = domain === 'triathlon' || domain === 'secretary' || domain === 'content' || domain === 'finance';
  const needsFinance = domain === 'triathlon' || domain === 'secretary' || domain === 'cooking' || domain === 'content';
  const needsContent = domain === 'triathlon' || domain === 'secretary' || domain === 'finance' || domain === 'cooking';
  const needsSecretary = domain === 'triathlon' || domain === 'cooking' || domain === 'content';

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

function buildSkillOwnershipLines(domain: DomainName): string[] {
  const target = domain === 'triathlon' ? 'training' : domain;
  return [
    '- Secretary owns schedule placement, agenda feasibility, reminders, reflow, and calendar arbitration.',
    '- Training owns workout content, recovery logic, and training-plan shape.',
    '- Cooking owns meals, groceries, meal prep, and fueling content.',
    '- Finance owns budget, bill, subscription, tax, and purchase constraints.',
    '- Content owns content workload, references, publishing cadence, and execution state.',
    `- This context is advisory for ${target}; downstream writes still belong to the owning skill.`,
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

function buildSectionsForDomain(domain: DomainName, bundle: MeshBundle): string[] {
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
        summarizeTrainingForContent(bundle.training),
        summarizeSecretaryForContent(bundle.secretary),
        summarizeFinanceForContent(bundle.finance),
        summarizeCookingForContent(bundle.cooking),
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

function buildContractsForDomain(domain: DomainName, bundle: MeshBundle): SharedDecisionContracts {
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
        training: buildTrainingContractForContent(bundle.training),
        secretary: buildSecretaryContractForContent(bundle.secretary),
        finance: buildFinanceContractForContent(bundle.finance),
        cooking: buildCookingContractForContent(bundle.cooking),
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
  if (!recovery && !session && !immovability && hardDays == null) return '';

  const facts: string[] = [];
  if (recovery) facts.push(`recovery is ${recovery.state}`);
  if (session) facts.push(`next key session is ${session.title} on ${session.date}`);
  if (immovability) facts.push(`session immovability is ${immovability.level} for ${immovability.title}`);
  if (hardDays != null) facts.push(`${hardDays} hard day(s) are planned this week`);
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
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  if (!commitment && !filming && !isActionableContentExecution(nextExecution)) return '';

  const facts: string[] = [];
  if (commitment) facts.push(`${commitment.upcomingTopicCount} topic(s) are queued`);
  if (commitment?.nextDate) {
    facts.push(
      commitment.nextTopicTitle
        ? `next publish target is "${commitment.nextTopicTitle}" on ${commitment.nextDate}`
        : `next publish target lands on ${commitment.nextDate}`,
    );
  }
  if (filming) facts.push(`best filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Treat filming and publishing as real calendar commitments when the user asks to execute them.');
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
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  if (!commitment && !filming && !nextExecution) return '';

  const facts: string[] = [];
  if (commitment) facts.push(`${commitment.upcomingTopicCount} topic(s) are queued`);
  if (filming) facts.push(`filming is currently best on ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Account for creator workload before locking a hard week.');
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
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  if (!commitment && !filming && !isActionableContentExecution(nextExecution)) return '';

  const facts: string[] = [];
  if (commitment) {
    facts.push(
      commitment.nextDate && commitment.nextTopicTitle
        ? `next publish target is "${commitment.nextTopicTitle}" on ${commitment.nextDate}`
        : `${commitment.upcomingTopicCount} topic(s) are queued`,
    );
  }
  if (filming) facts.push(`best filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
  if (nextExecution && isActionableContentExecution(nextExecution)) {
    facts.push(formatNextContentExecutionFact(nextExecution));
  }
  return formatSection('Content', facts, 'Treat filming and shipping days as meal-support days, not as invisible obligations.');
}

function summarizeTrainingForContent(training: TrainingMeshContext | null): string {
  if (!training) return '';
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const story = extractTrainingContentStory(training);
  if (!recovery && !session && !immovability && !story) return '';

  const facts: string[] = [];
  if (recovery) facts.push(`recovery is ${recovery.state}`);
  if (session) facts.push(`next session is ${session.title} on ${session.date}`);
  if (immovability) facts.push(`session immovability is ${immovability.level}`);
  if (story) facts.push(`story angle is ${story.angle} around "${story.title}" on ${story.date}`);
  return formatSection('Training', facts, 'Avoid suggesting demanding production around low-recovery or hard-session windows.');
}

function summarizeSecretaryForContent(secretary: SecretaryMeshContext | null): string {
  if (!secretary) return '';
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const criticality = extractSecretaryMeetingCriticality(secretary);
  if (!busy && !travel && !focus && !inbox && !criticality) return '';

  const facts: string[] = [];
  if (busy?.dates.length) facts.push(`calendar is busy on ${busy.dates.length} day(s) with ${busy.totalEvents} events`);
  if (travel?.dates.length) facts.push(`travel is scheduled on ${travel.dates.join(', ')}`);
  if (focus) facts.push(`focus protection is currently best on ${focus.date}`);
  if (inbox && (inbox.overdueCount > 0 || inbox.dueTodayCount > 0)) {
    facts.push(`admin pressure shows ${inbox.overdueCount} overdue and ${inbox.dueTodayCount} due today`);
  }
  if (criticality?.criticalEventCount) facts.push(`${criticality.criticalEventCount} critical meeting(s) already occupy the week`);
  return formatSection('Secretary', facts, 'Respect calendar pressure before promising production or delivery blocks.');
}

function summarizeFinanceForContent(finance: FinanceMeshContext | null): string {
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
  if (budget?.contentSpendMode) facts.push(`content spend mode is ${budget.contentSpendMode}`);
  if (taxDeadline) facts.push(`tax deadline lands on ${taxDeadline.reminderDate}`);
  return formatSection('Finance', facts, 'Prefer lower-friction production asks during tighter admin or money weeks.');
}

function summarizeCookingForContent(cooking: CookingMeshContext | null): string {
  if (!cooking) return '';
  const window = extractMealWindow(cooking);
  if (!window || window.missingDates.length === 0) return '';
  return `Cooking: ${window.missingDates.length} day(s) still have no meals planned. Keep content production realistic when the user's week still lacks food coverage.`;
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
  const commitment = extractPublishingCommitment(content);
  const nextExecution = extractNextContentExecution(content);
  if (!commitment && !isActionableContentExecution(nextExecution)) return '';
  const facts = compact([
    commitment ? `${commitment.upcomingTopicCount} topic(s) are queued` : null,
    nextExecution && isActionableContentExecution(nextExecution)
      ? formatNextContentExecutionFact(nextExecution)
      : null,
  ]);
  return formatSection('Content', facts, 'Factor creator obligations into subscription or production-cost decisions.');
}

function buildTrainingContractForSecretary(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const hardDays = extractHardDayCount(training);
  // Surface the Content-deprioritization implication to Secretary
  // explicitly. When recovery is strained or critical, filming /
  // capture work is the natural first-candidate for deferral. Without
  // this, Secretary sees "recovery is strained" but no hint that
  // content blocks could reclaim time; the weekly planner therefore
  // keeps filming slots as immutable when they shouldn't be.
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
        ? 'Filming and content-capture blocks are the first-candidate for deferral while recovery stabilizes.'
        : null,
    ]),
    notes: compact([
      recovery ? `Recovery state: ${recovery.state}.` : null,
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
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  // Surface the pre-publish filming window as an immovable block to
  // Secretary. The publishing_commitment signal carries nextDate but
  // on its own nothing translates it into a blocked filming window,
  // so the weekly planner treats filming as flexible even when
  // publishing is only 3 days out. Rule: filming should land 3–5
  // calendar days before publish to leave edit + render time. When a
  // nextDate exists, surface that window as a non-negotiable so
  // Secretary's calendar stops booking meetings into it.
  const filmingWindow = commitment?.nextDate
    ? computePreferredFilmingWindow(commitment.nextDate)
    : null;
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate
        ? `Publishing commitment lands on ${commitment.nextDate}${commitment.nextTopicTitle ? ` for "${commitment.nextTopicTitle}"` : ''}.`
        : null,
      filmingWindow
        ? `Protect ${filmingWindow.start}\u2013${filmingWindow.end} as the filming/edit window for that publish date.`
        : null,
    ]),
    preferredWindows: compact([
      filming ? `Best filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}.` : null,
      nextExecution?.scheduledDate && isActionableContentExecution(nextExecution)
        ? `Keep the next content move visible by ${nextExecution.scheduledDate}.`
        : null,
    ]),
    fallbackIfDeferred: compact([
      commitment?.upcomingTopicCount && commitment.upcomingTopicCount > 0
        ? 'If the day compresses, reschedule lower-value admin before moving filming or publishing work.'
        : null,
      !commitment && nextExecution && isActionableContentExecution(nextExecution)
        ? 'If the day compresses, defer lower-value admin before letting the next content move disappear into backlog.'
        : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: compact([
      commitment ? `${commitment.upcomingTopicCount} topic(s) remain queued.` : null,
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

/**
 * Compute the 3-to-5-day-before-publish filming window from a publish
 * date in YYYY-MM-DD form. Returns ISO dates for the start and end of
 * the window, or null if the publish date can't be parsed.
 *
 * Rationale: 3 days minimum gives edit + render + thumbnail time; 5
 * days max keeps filming tight enough that context and hook relevance
 * stay fresh. Beyond 5 days, filming slot is no longer "required" for
 * this publish cycle.
 */
function computePreferredFilmingWindow(publishDate: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(publishDate);
  if (!match) return null;
  const utcPublish = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utcPublish)) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(utcPublish - 5 * dayMs).toISOString().slice(0, 10);
  const end = new Date(utcPublish - 3 * dayMs).toISOString().slice(0, 10);
  return { start, end };
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
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Publishing commitment is due on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: compact([
      filming ? `Filming window currently points to ${filming.date}${filming.window ? ` ${filming.window}` : ''}.` : null,
      nextExecution && isActionableContentExecution(nextExecution) ? formatNextContentExecutionFact(nextExecution) + '.' : null,
    ]),
    fallbackIfDeferred: compact([
      filming ? 'Place production after protected training and fueling commitments instead of before them.' : null,
      nextExecution && isActionableContentExecution(nextExecution)
        ? 'Avoid stacking hard doubles on the same day as the next content execution unless Secretary confirms spare capacity.'
        : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: compact([
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
  const commitment = extractPublishingCommitment(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Creator deliverable is due on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      commitment ? 'Prioritize meals that support filming and shipping days when content is active.' : null,
      !commitment && nextExecution && isActionableContentExecution(nextExecution)
        ? 'Keep meals lower-friction on content execution days so production work does not compete with food prep.'
        : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: compact([
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
}

function buildTrainingContractForContent(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  // Explicit deprioritization guidance when recovery degrades. With
  // only the `strained` fall-through, `critical` had no special handling
  // and both states produced a single "avoid demanding production" line.
  // The branches below emit concrete actions the content agent can
  // apply without re-inferring from the state string.
  const recoveryCritical = recovery?.state === 'critical';
  const recoveryStrained = recovery?.state === 'strained';
  return createContract({
    nonNegotiables: compact([
      recoveryCritical
        ? 'Defer filming and new capture asks — recovery is critical, protect it explicitly this week.'
        : recoveryStrained
          ? 'Avoid demanding production around strained recovery windows.'
          : null,
      session ? `Protect ${session.title} on ${session.date} before placing filming.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      recoveryCritical
        ? 'Move filming to a future recovered-state week; surface this to Secretary so the calendar slot re-opens.'
        : null,
      session ? 'Move content around training first; do not ask training to absorb creator load by default.' : null,
    ]),
    notes: compact([
      recoveryCritical || recoveryStrained
        ? 'Content-capture priority is currently deprioritized while recovery stabilizes.'
        : null,
    ]),
  });
}

function buildSecretaryContractForContent(secretary: SecretaryMeshContext | null): PeerDecisionContract | null {
  if (!secretary) return null;
  const busy = extractSecretaryBusy(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  // Secretary's focus window is binding on Content too. Filming or
  // capture blocks landing on a protected focus day is a common
  // failure mode where the weekly planner shows a conflict in the
  // review step and the user has to arbitrate manually. Making the
  // focus block a Content non-negotiable pushes the avoidance earlier
  // in the agent loop.
  return createContract({
    nonNegotiables: compact([
      busy?.dates.length ? `Calendar pressure is already high on ${busy.dates.join(', ')}.` : null,
      focus ? `Do not place filming or capture blocks on ${focus.date} — Secretary is protecting it as a focus block.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      inbox && inbox.overdueCount > 0 ? 'If content slips, clear overdue admin before expanding production commitments.' : null,
    ]),
    notes: [],
  });
}

function buildFinanceContractForContent(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  return createContract({
    nonNegotiables: compact([
      budget?.integrity === 'mixed_currency'
        ? `Budget posture is provisional for ${budget.month} because currencies are mixed. Avoid assuming room for paid production upgrades.`
        : null,
    ]),
    preferredWindows: compact([
      budget?.contentSpendMode ? `Content spend mode is ${budget.contentSpendMode}.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight' ? 'Prefer lower-friction production asks while the budget is tight.' : null,
      budget?.recurringExpenseCount
        ? `Recurring commitments still likely this month (${budget.recurringExpenseCount}) should push content toward lighter execution, not extra spending.`
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: compact([
      budget ? buildBudgetContractNote(budget) : null,
      formatRecurringExpenseContractNote(budget),
    ]),
  });
}

function buildCookingContractForContent(cooking: CookingMeshContext | null): PeerDecisionContract | null {
  if (!cooking) return null;
  const support = extractFuelingSupportStatus(cooking);
  return createContract({
    nonNegotiables: [],
    preferredWindows: [],
    fallbackIfDeferred: compact([
      support?.status === 'at_risk' ? 'Treat filming days as meal-support days, not as invisible obligations.' : null,
    ]),
    notes: [],
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
  const commitment = extractPublishingCommitment(content);
  const nextExecution = extractNextContentExecution(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Creator commitment still lands on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      commitment ? 'Subscription or production-cost advice should respect active creator commitments.' : null,
      !commitment && nextExecution && isActionableContentExecution(nextExecution)
        ? 'Cost guidance should preserve the next content move instead of assuming creator work is optional this week.'
        : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: compact([
      nextExecution && isActionableContentExecution(nextExecution)
        ? `Next execution: ${formatNextContentExecutionFact(nextExecution)}.`
        : null,
    ]),
  });
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

function extractPublishingCommitment(content: ContentMeshContext): {
  upcomingTopicCount: number;
  nextDate: string | null;
  nextTopicTitle: string | null;
} | null {
  const signal = content.derivedSignals.find((entry) => entry.signalType === 'publishing_commitment');
  const upcomingTopicCount = signal?.payload.upcomingTopicCount;
  return typeof upcomingTopicCount === 'number'
    ? {
        upcomingTopicCount,
        nextDate: typeof signal?.payload.nextDate === 'string' ? signal.payload.nextDate : null,
        nextTopicTitle: typeof signal?.payload.nextTopicTitle === 'string' ? signal.payload.nextTopicTitle : null,
      }
    : null;
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
  switch (execution.mode) {
    case 'publish_ready':
      return execution.scheduledDate
        ? `next content move is to ship "${execution.title}" by ${execution.scheduledDate}`
        : `next content move is to ship "${execution.title}"`;
    case 'script_ready':
      return execution.scheduledDate
        ? `next content move is to execute the ready script "${execution.title}" by ${execution.scheduledDate}`
        : `next content move is to execute the ready script "${execution.title}"`;
    case 'reaction_window':
      return `next content move is a reaction window for "${execution.title}"`;
    case 'film_window':
      return execution.scheduledDate
        ? `next content move is to capture "${execution.title}" on ${execution.scheduledDate}`
        : `next content move is to capture "${execution.title}"`;
    default:
      return execution.scheduledDate
        ? `next content move is "${execution.title}" by ${execution.scheduledDate}`
        : `next content move is "${execution.title}"`;
  }
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
    || Boolean(contract.budgetMode)
    || Boolean(contract.publishDeadline);
}

function formatSection(label: string, facts: string[], tail: string): string {
  return `${label}: ${dedupeStrings(facts).join('; ')}. ${tail}`;
}
