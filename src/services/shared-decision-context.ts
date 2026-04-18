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
  type SecretaryMeshContext,
  type TrainingMeshContext,
} from './cross-agent-learning';
import { formatCurrencyAmount } from './finance-tracker';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

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

export function invalidateSharedDecisionContextCache(userId?: number): void {
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    const prefix = `${userId}:`;
    for (const key of _sharedDecisionContextCache.keys()) {
      if (key.startsWith(prefix)) {
        _sharedDecisionContextCache.delete(key);
      }
    }
    return;
  }

  _sharedDecisionContextCache.clear();
}

export async function buildSharedDecisionContext(domain: DomainName, userId: number): Promise<string> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId);
  return artifacts.text;
}

export async function buildSharedDecisionContracts(domain: DomainName, userId: number): Promise<SharedDecisionContracts> {
  const artifacts = await buildSharedDecisionArtifacts(domain, userId);
  return artifacts.contracts;
}

async function buildSharedDecisionArtifacts(
  domain: DomainName,
  userId: number,
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

  const cacheKey = `${userId}:${domain}`;
  const cached = _sharedDecisionContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return {
      text: cached.text,
      contracts: cached.contracts,
    };
  }

  const bundle = await readRelevantPeerContexts(domain, userId);
  const sections = buildSectionsForDomain(domain, bundle);
  const text = sections.length > 0
    ? [
      `<shared_decision_context domain="${domain}">`,
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

async function readRelevantPeerContexts(domain: DomainName, userId: number): Promise<MeshBundle> {
  const needsTraining = domain !== 'triathlon';
  const needsCooking = domain === 'triathlon' || domain === 'secretary' || domain === 'content' || domain === 'finance';
  const needsFinance = domain === 'triathlon' || domain === 'secretary' || domain === 'cooking' || domain === 'content';
  const needsContent = domain === 'triathlon' || domain === 'secretary' || domain === 'finance' || domain === 'cooking';
  const needsSecretary = domain === 'triathlon' || domain === 'cooking' || domain === 'content';

  const [training, cooking, finance, content, secretary] = await Promise.allSettled([
    needsTraining ? readTrainingMeshContext({ userId }) : Promise.resolve(null),
    needsCooking ? readCookingMeshContext({ userId }) : Promise.resolve(null),
    needsFinance ? readFinanceMeshContext({ userId }) : Promise.resolve(null),
    needsContent ? readContentMeshContext({ userId }) : Promise.resolve(null),
    needsSecretary ? readSecretaryMeshContext({ userId }) : Promise.resolve(null),
  ]);

  return {
    training: training.status === 'fulfilled' ? training.value : null,
    cooking: cooking.status === 'fulfilled' ? cooking.value : null,
    finance: finance.status === 'fulfilled' ? finance.value : null,
    content: content.status === 'fulfilled' ? content.value : null,
    secretary: secretary.status === 'fulfilled' ? secretary.value : null,
  };
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
  if (budget) facts.push(`budget remaining is ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}`);
  if (budget?.budgetMode) facts.push(`budget mode is ${budget.budgetMode}`);
  if (taxDeadline) facts.push(`tax deadline lands on ${taxDeadline.reminderDate}`);
  if (renewal) facts.push(`${renewal.plan} renews on ${renewal.currentPeriodEnd.slice(0, 10)}`);
  return formatSection('Finance', facts, 'Prioritize admin obligations before optional blocks.');
}

function summarizeContentForSecretary(content: ContentMeshContext | null): string {
  if (!content) return '';
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  if (!commitment && !filming) return '';

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
        ? `fueling support is ${fuelingSupport.status} because ${fuelingSupport.hardDatesMissingMeals.length} hard training day(s) still lack meals`
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
  if (budget) facts.push(`budget remaining is ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}`);
  if (budget?.trainingSpendMode) facts.push(`training spend mode is ${budget.trainingSpendMode}`);
  if (budget?.supplementMode) facts.push(`supplement mode is ${budget.supplementMode}`);
  if (taxDeadline) facts.push(`tax deadline lands on ${taxDeadline.reminderDate}`);
  return formatSection('Finance', facts, 'Keep travel, equipment, and supplement advice realistic.');
}

function summarizeContentForTraining(content: ContentMeshContext | null): string {
  if (!content) return '';
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  if (!commitment && !filming) return '';

  const facts: string[] = [];
  if (commitment) facts.push(`${commitment.upcomingTopicCount} topic(s) are queued`);
  if (filming) facts.push(`filming is currently best on ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
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
  const facts = [
    `budget remaining is ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}`,
    `grocery mode is ${budget.groceryMode}`,
  ];
  return formatSection('Finance', facts, 'Keep recipe and shopping suggestions cost-aware.');
}

function summarizeContentForCooking(content: ContentMeshContext | null): string {
  if (!content) return '';
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  if (!commitment && !filming) return '';

  const facts: string[] = [];
  if (commitment) {
    facts.push(
      commitment.nextDate && commitment.nextTopicTitle
        ? `next publish target is "${commitment.nextTopicTitle}" on ${commitment.nextDate}`
        : `${commitment.upcomingTopicCount} topic(s) are queued`,
    );
  }
  if (filming) facts.push(`best filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}`);
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
  if (budget) facts.push(`budget remaining is ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}`);
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
  if (!commitment) return '';
  return `Content: ${commitment.upcomingTopicCount} topic(s) are queued. Factor creator obligations into subscription or production-cost decisions.`;
}

function buildTrainingContractForSecretary(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  const immovability = extractSessionImmovability(training);
  const hardDays = extractHardDayCount(training);
  return createContract({
    nonNegotiables: compact([
      immovability?.level === 'high' && session
        ? `Keep ${session.title} on ${session.date} protected before moving lower-value work.`
        : null,
      recovery?.state === 'strained'
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
    ]),
    notes: compact([recovery ? `Recovery state: ${recovery.state}.` : null]),
  });
}

function buildCookingContractForSecretary(cooking: CookingMeshContext | null): PeerDecisionContract | null {
  if (!cooking) return null;
  const window = extractMealWindow(cooking);
  const readiness = extractMealExecutionReadiness(cooking);
  const support = extractFuelingSupportStatus(cooking);
  const spend = extractGroceryForecast(cooking);
  return createContract({
    nonNegotiables: compact([
      support?.hardDatesMissingMeals.length
        ? `Hard training day meal coverage is still missing on ${support.hardDatesMissingMeals.join(', ')}.`
        : null,
    ]),
    preferredWindows: compact([
      window?.missingDates.length
        ? `Leave prep or shopping time for uncovered dates: ${window.missingDates.join(', ')}.`
        : null,
    ]),
    fallbackIfDeferred: compact([
      readiness?.status === 'at_risk'
        ? 'If the week gets crowded, simplify meals instead of dropping fueling support entirely.'
        : null,
    ]),
    notes: compact([spend ? `Shopping forecast: ${formatCurrencyAmount(spend.currency, spend.amount)}.` : null]),
  });
}

function buildFinanceContractForSecretary(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  return createContract({
    nonNegotiables: compact([
      taxDeadline ? `Tax/admin follow-up is due by ${taxDeadline.reminderDate}.` : null,
    ]),
    preferredWindows: compact([
      budget?.budgetMode ? `Keep optional blocks aligned with the ${budget.budgetMode} budget mode.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.remainingRatio != null && budget.remainingRatio <= 0.1
        ? 'Prefer admin completion and low-cost execution before adding optional commitments.'
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: compact([budget ? `Budget remaining: ${Math.round(budget.remainingRatio * 100)}% for ${budget.month}.` : null]),
  });
}

function buildContentContractForSecretary(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate
        ? `Publishing commitment lands on ${commitment.nextDate}${commitment.nextTopicTitle ? ` for "${commitment.nextTopicTitle}"` : ''}.`
        : null,
    ]),
    preferredWindows: compact([
      filming ? `Best filming window is ${filming.date}${filming.window ? ` ${filming.window}` : ''}.` : null,
    ]),
    fallbackIfDeferred: compact([
      commitment?.upcomingTopicCount && commitment.upcomingTopicCount > 0
        ? 'If the day compresses, reschedule lower-value admin before moving filming or publishing work.'
        : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: compact([commitment ? `${commitment.upcomingTopicCount} topic(s) remain queued.` : null]),
  });
}

function buildSecretaryContractForTraining(secretary: SecretaryMeshContext | null): PeerDecisionContract | null {
  if (!secretary) return null;
  const busy = extractSecretaryBusy(secretary);
  const travel = extractSecretaryTravel(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  const focus = extractSecretaryFocus(secretary);
  return createContract({
    nonNegotiables: compact([
      travel?.dates.length ? `Travel is fixed on ${travel.dates.join(', ')}.` : null,
      busy?.dates.length ? `Busy calendar blocks already land on ${busy.dates.join(', ')}.` : null,
    ]),
    preferredWindows: compact([
      focus ? `Use ${focus.date} as the best protected focus day.` : null,
    ]),
    fallbackIfDeferred: compact([
      inbox && (inbox.overdueCount > 0 || inbox.dueTodayCount > 0)
        ? 'If training has to move, clear overdue or due-today admin before expanding optional work.'
        : null,
    ]),
    notes: compact([inbox ? `Admin pressure: ${inbox.overdueCount} overdue, ${inbox.dueTodayCount} due today.` : null]),
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
        ? 'Downgrade fueling ambition before forcing a hard session through unsupported meals.'
        : null,
    ]),
    notes: compact([spend ? `Shopping forecast: ${formatCurrencyAmount(spend.currency, spend.amount)}.` : null]),
  });
}

function buildFinanceContractForTraining(finance: FinanceMeshContext | null): PeerDecisionContract | null {
  if (!finance) return null;
  const budget = extractBudget(finance);
  const taxDeadline = extractTaxDeadline(finance);
  return createContract({
    nonNegotiables: compact([
      taxDeadline ? `Tax/admin deadline hits ${taxDeadline.reminderDate}.` : null,
    ]),
    preferredWindows: compact([
      budget?.trainingSpendMode ? `Training spend mode is ${budget.trainingSpendMode}.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight'
        ? 'Favor lower-friction or lower-cost training execution if the week is already tight.'
        : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: [],
  });
}

function buildContentContractForTraining(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const commitment = extractPublishingCommitment(content);
  const filming = extractFilmingRecommendation(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Publishing commitment is due on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: compact([
      filming ? `Filming window currently points to ${filming.date}${filming.window ? ` ${filming.window}` : ''}.` : null,
    ]),
    fallbackIfDeferred: compact([
      filming ? 'Place production after protected training and fueling commitments instead of before them.' : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: [],
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
  return createContract({
    nonNegotiables: compact([
      travel?.dates.length ? `Travel lands on ${travel.dates.join(', ')}.` : null,
    ]),
    preferredWindows: compact([
      focus ? `Prep or shopping is easiest to place on ${focus.date}.` : null,
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
  return createContract({
    nonNegotiables: [],
    preferredWindows: compact([
      budget?.groceryMode ? `Grocery mode is ${budget.groceryMode}.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight' ? 'Favor repeatable lower-cost staples before novelty recipes.' : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: [],
  });
}

function buildContentContractForCooking(content: ContentMeshContext | null): PeerDecisionContract | null {
  if (!content) return null;
  const commitment = extractPublishingCommitment(content);
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Creator deliverable is due on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      commitment ? 'Prioritize meals that support filming and shipping days when content is active.' : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: [],
  });
}

function buildTrainingContractForContent(training: TrainingMeshContext | null): PeerDecisionContract | null {
  if (!training) return null;
  const recovery = extractRecoveryState(training);
  const session = extractSessionPrescription(training);
  return createContract({
    nonNegotiables: compact([
      recovery?.state === 'strained' ? 'Avoid demanding production around strained recovery windows.' : null,
      session ? `Protect ${session.title} on ${session.date} before placing filming.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      session ? 'Move content around training first; do not ask training to absorb creator load by default.' : null,
    ]),
    notes: [],
  });
}

function buildSecretaryContractForContent(secretary: SecretaryMeshContext | null): PeerDecisionContract | null {
  if (!secretary) return null;
  const busy = extractSecretaryBusy(secretary);
  const focus = extractSecretaryFocus(secretary);
  const inbox = extractSecretaryInboxPressure(secretary);
  return createContract({
    nonNegotiables: compact([
      busy?.dates.length ? `Calendar pressure is already high on ${busy.dates.join(', ')}.` : null,
    ]),
    preferredWindows: compact([
      focus ? `Protected focus is strongest on ${focus.date}.` : null,
    ]),
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
    nonNegotiables: [],
    preferredWindows: compact([
      budget?.contentSpendMode ? `Content spend mode is ${budget.contentSpendMode}.` : null,
    ]),
    fallbackIfDeferred: compact([
      budget?.budgetMode === 'tight' ? 'Prefer lower-friction production asks while the budget is tight.' : null,
    ]),
    budgetMode: budget?.budgetMode ?? null,
    notes: [],
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
  return createContract({
    nonNegotiables: compact([
      commitment?.nextDate ? `Creator commitment still lands on ${commitment.nextDate}.` : null,
    ]),
    preferredWindows: [],
    fallbackIfDeferred: compact([
      commitment ? 'Subscription or production-cost advice should respect active creator commitments.' : null,
    ]),
    publishDeadline: commitment?.nextDate ?? null,
    notes: [],
  });
}

function extractRecoveryState(training: TrainingMeshContext): { state: string } | null {
  const signal = training.derivedSignals.find((entry) => entry.signalType === 'recovery_state');
  const state = signal?.payload.state;
  return typeof state === 'string' ? { state } : null;
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
): { status: string } | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'meal_execution_readiness');
  const status = signal?.payload.status;
  return typeof status === 'string' ? { status } : null;
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
  remainingRatio: number;
  budgetMode: string | null;
  groceryMode: string | null;
  trainingSpendMode: string | null;
  contentSpendMode: string | null;
  supplementMode: string | null;
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
  const month = signal?.payload.month;
  const remainingRatio = signal?.payload.remainingRatio;
  if (typeof month !== 'string' || typeof remainingRatio !== 'number') return null;
  return {
    month,
    remainingRatio,
    budgetMode: typeof signal?.payload.budgetMode === 'string' ? signal.payload.budgetMode : null,
    groceryMode: typeof signal?.payload.groceryMode === 'string' ? signal.payload.groceryMode : null,
    trainingSpendMode: typeof signal?.payload.trainingSpendMode === 'string' ? signal.payload.trainingSpendMode : null,
    contentSpendMode: typeof signal?.payload.contentSpendMode === 'string' ? signal.payload.contentSpendMode : null,
    supplementMode: typeof signal?.payload.supplementMode === 'string' ? signal.payload.supplementMode : null,
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

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

function compactContracts(
  contracts: Partial<Record<PeerSkill, PeerDecisionContract | null>>,
): SharedDecisionContracts {
  return Object.fromEntries(
    Object.entries(contracts).filter(([, contract]) => hasContractContent(contract)),
  ) as SharedDecisionContracts;
}

function createContract(contract: PeerDecisionContract): PeerDecisionContract | null {
  return hasContractContent(contract) ? contract : null;
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
  return `${label}: ${facts.join('; ')}. ${tail}`;
}
