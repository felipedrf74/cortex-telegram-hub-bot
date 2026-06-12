// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ScreenContractMeta } from './screen-contract-meta';
import { buildScreenContractMeta } from './screen-contract-meta';
import type { Lang } from '../utils/i18n';

export type TrainingDayStateKind =
  | 'ready'
  | 'caution'
  | 'recovery'
  | 'lowConfidence'
  | 'missedSessionRecovery'
  | 'conflictingSchedule'
  | 'completed'
  | 'noPlan'
  | 'insufficientData';

export type TrainingSemanticTint =
  | 'accent'
  | 'success'
  | 'warning'
  | 'info'
  | 'secretary'
  | 'content'
  | 'error';

export type TrainingHeroActionTarget =
  | 'completeSession'
  | 'skipSession'
  | 'openWeekPlan'
  | 'createPlan'
  | 'refreshCoach'
  | 'applyCoachRecommendations'
  | 'openIntegrations';

export type TrainingHeroActionPriority = 'primary' | 'secondary';
export type TrainingReasoningTone = 'supportive' | 'caution' | 'protective';
export type WeekJourneyState =
  | 'completed'
  | 'today'
  | 'adapted'
  | 'key'
  | 'missed'
  | 'recovery'
  | 'planned'
  | 'rest';

export interface TrainingHeroActionModel {
  id: string;
  title: string;
  subtitle: string | null;
  icon: string;
  tint: TrainingSemanticTint;
  target: TrainingHeroActionTarget;
  priority: TrainingHeroActionPriority;
}

export interface TrainingHeroMetric {
  id: string;
  label: string;
  value: string;
  icon: string;
}

/** A compact description of a prescribed training session.
 *
 *  Used as the before/after pair on the hero so the UI can render
 *  "You were scheduled for Long Run (90 min), now it's a Tempo Run
 *  (45 min) because your readiness dropped" without re-deriving from
 *  the LLM briefing. When the original and the adapted are identical
 *  the renderer should hide the "was X, now Y" affordance. */
export interface TrainingPrescriptionSummary {
  /** Localized title — e.g. "Corrida tempo" in pt-BR, "Tempo Run" in en-US. */
  title: string;
  /** Short one-line detail — intended to complement the title (e.g.
   *  "45 min · zona 4" or "Maintenance strength · 60 min"). May be
   *  empty when the planner didn't emit enough info. */
  detail: string;
  /** Minutes, if known. */
  durationMinutes: number | null;
  /** Raw sessionType enum from the kernel (e.g. 'threshold_run'). Useful
   *  for client-side icon selection and analytics bucketing. */
  sessionType: string | null;
}

export interface TodayRecommendationCardModel {
  state: TrainingDayStateKind;
  eyebrow: string;
  title: string;
  subtitle: string;
  coachSentence: string;
  statusLabel: string;
  statusTint: TrainingSemanticTint;
  readinessLabel: string | null;
  confidenceLabel: string | null;
  primaryAction: TrainingHeroActionModel;
  secondaryAction: TrainingHeroActionModel | null;
  supportingMetrics: TrainingHeroMetric[];
  /** What the weekly plan originally prescribed for today. Null when we
   *  don't have a stored plan to compare against. */
  originalPrescription: TrainingPrescriptionSummary | null;
  /** What the coach adapted today into after re-running guardrails with
   *  live readiness. Null when there is no session today. Equal to
   *  `originalPrescription` when no adaptation happened. */
  adaptedPrescription: TrainingPrescriptionSummary | null;
}

export interface TrainingReasoningMetric {
  id: string;
  label: string;
  value: string;
  tint: TrainingSemanticTint;
}

export interface TrainingReasoningSignal {
  id: string;
  title: string;
  effect: string;
  detail: string | null;
  timestamp: string | null;
  tone: TrainingReasoningTone;
}

export interface CoachReasoningModel {
  title: string;
  summary: string;
  confidenceLabel: string;
  metrics: TrainingReasoningMetric[];
  signals: TrainingReasoningSignal[];
}

export type CoachReviewState = 'ready' | 'needsRefresh' | 'degraded';

export interface CoachReviewModel {
  state: CoachReviewState;
  title: string;
  summary: string;
  detail: string;
  highlights: string[];
  primaryAction: TrainingHeroActionModel;
  secondaryAction: TrainingHeroActionModel | null;
}

export interface WeekProtectionModel {
  title: string;
  summary: string;
  changedFrom: string | null;
  changedTo: string | null;
  impactLines: string[];
  /** Deterministic adjustments authored by the coach kernel (not the LLM).
   *  Each line is pre-formatted as "ruleId: message" and represents a
   *  guardrail that actually fired during plan generation. When present
   *  these are the authoritative "what changed" — the LLM briefing is an
   *  enrichment, not the source of truth. */
  kernelAdjustments: string[];
  primaryAction: TrainingHeroActionModel;
  secondaryAction: TrainingHeroActionModel | null;
}

export interface WeekJourneyDay {
  id: string;
  dayLabel: string;
  title: string;
  subtitle: string | null;
  state: WeekJourneyState;
}

export interface WeekJourneyModel {
  title: string;
  subtitle: string;
  adherenceText: string;
  days: WeekJourneyDay[];
}

export interface TrainingEmptyStateModel {
  title: string;
  summary: string;
  detail: string;
  action: TrainingHeroActionModel;
}

/** Adherence-focused coaching card. Fires when the user is drifting
 *  from their plan (adherence < 60% over the trailing week) but has an
 *  active plan to drift from. The copy is intentionally supportive
 *  rather than punitive — the product stance is "coach, not auditor". */
export interface LowAdherenceCoachingCardModel {
  /** Short eyebrow label — "Esta semana" / "This week". */
  eyebrow: string;
  title: string;
  summary: string;
  /** One-line actionable tip derived from the current adherence rate. */
  tip: string;
  /** Raw adherence percent (0-100) so the UI can render a gauge
   *  without re-parsing the label. */
  adherencePercent: number;
  primaryAction: TrainingHeroActionModel;
}

/** Structured confidence bucket for the entire Training Home read.
 *
 *  Until now the contract only exposed a localized label string
 *  ("Alta confiança" / "High confidence"). That's fine for presentation
 *  but can't be consumed programmatically by the client — analytics
 *  buckets, trust banner decisions, and automated regression tests all
 *  need a stable machine-readable value.
 *
 *  The localized `hero.confidenceLabel` / `reasoning.confidenceLabel`
 *  remain for display. This enum is the source of truth — the label is
 *  derived from it. */
export type TrainingHomeConfidenceLevel = 'high' | 'medium' | 'low';

export interface TrainingHomeViewState {
  meta: ScreenContractMeta;
  hero: TodayRecommendationCardModel;
  reasoning: CoachReasoningModel | null;
  coachReview: CoachReviewModel | null;
  weekProtection: WeekProtectionModel | null;
  weekJourney: WeekJourneyModel | null;
  emptyState: TrainingEmptyStateModel | null;
  /** Machine-readable confidence bucket — see TrainingHomeConfidenceLevel. */
  confidence: TrainingHomeConfidenceLevel;
  /** Shown when the user's weekly adherence is materially below target
   *  and we have a plan to coach against. Null when not applicable. */
  lowAdherenceCard: LowAdherenceCoachingCardModel | null;
}

export interface ReadinessFactorsInput {
  sleepScore?: number | null;
  hrvStatus?: string | null;
  bodyBattery?: number | null;
  trainingLoad?: string | null;
  restingHeartRate?: number | null;
  stressLevel?: string | null;
}

export interface ReadinessInput {
  score: number;
  factors: ReadinessFactorsInput;
  recommendation?: string | null;
}

export interface TrainingExerciseInput {
  name: string;
}

export interface TrainingSessionInput {
  id?: string | null;
  type: string;
  sessionType?: string | null;
  time?: string | null;
  duration?: number | null;
  status: string;
  notes?: string | null;
  exercises?: TrainingExerciseInput[] | null;
}

export interface WeekSessionInput {
  id?: string | null;
  day: string;
  type: string;
  title?: string | null;
  sessionType?: string | null;
  time?: string | null;
  status: string;
  description?: string | null;
  duration?: number | null;
  exercises?: TrainingExerciseInput[] | null;
}

export interface CoachRecommendationInput {
  action: string;
  eventId?: string | null;
  source?: string | null;
  originalTitle?: string | null;
  newTitle?: string | null;
  newStart?: string | null;
  newEnd?: string | null;
  summary?: string | null;
  reason?: string | null;
}

export interface CoachBriefingInput {
  briefing: string;
  recommendations?: CoachRecommendationInput[] | null;
  degraded?: boolean | null;
  cachedOnlyMiss?: boolean | null;
}

export interface TrainingSignalInput {
  id: number;
  type: string;
  title: string;
  summary: string;
  priority: 'urgent' | 'normal' | 'background';
  source: string;
  createdAt: string;
  expiresAt: string;
  payload?: Record<string, any> | null;
}

/** Deterministic guardrail output from the coach-kernel planner-engine.
 *  `message` is a human-readable reason (e.g. "threshold_run → recovery_run
 *  because readiness is critically low"). The view-state surfaces ONLY
 *  guardrails that adjusted the plan (not `pass` results). */
export interface KernelGuardrailInput {
  ruleId: string;
  status: 'pass' | 'warn' | 'block';
  message: string;
  adjusted?: boolean;
}

export interface TrainingHomeViewStateInput {
  todaySession: TrainingSessionInput | null;
  readiness: ReadinessInput | null;
  coachBriefing: CoachBriefingInput | null;
  signals: TrainingSignalInput[];
  weekSessions: WeekSessionInput[];
  weeklyAdherence: number;
  tomorrowSession: WeekSessionInput | null;
  hasActivePlan: boolean;
  isGarminStale: boolean;
  /** Optional kernel guardrail results from the deterministic planner.
   *  When provided these drive the "what changed" story in
   *  WeekProtectionModel instead of relying on LLM briefing parsing. */
  kernelGuardrails?: KernelGuardrailInput[];
  /** What the stored weekly plan originally prescribed for today — used
   *  together with `todayAdaptedPrescription` to render the before/after
   *  affordance on the hero. Both are optional so callers can opt in
   *  incrementally. */
  todayOriginalPrescription?: TrainingPrescriptionSummary | null;
  /** What today was adapted into after re-running guardrails with live
   *  readiness. When equal to `todayOriginalPrescription` the UI should
   *  collapse the before/after into a single line. */
  todayAdaptedPrescription?: TrainingPrescriptionSummary | null;
  meta?: ScreenContractMeta | null;
}

interface TrainingTodayAdjustmentSummary {
  title: string;
  detail: string;
  tone: 'adjusted' | 'cautious' | 'ready' | 'limited' | 'steady';
  chips: string[];
}

export function buildTrainingHomeViewState(
  input: TrainingHomeViewStateInput,
  language: Lang,
): TrainingHomeViewState {
  const adjustmentSummary = resolveAdjustmentSummary(input, language);
  const state = classify({ ...input, adjustmentSummary });
  const confidenceLevel = computeConfidenceLevel({ ...input, adjustmentSummary });
  const confidence = labelForConfidence(confidenceLevel, language);

  return {
    meta: input.meta ?? inferTrainingContractMeta(input),
    hero: buildHero(state, confidence, input, adjustmentSummary, language),
    reasoning: buildReasoning(state, confidence, input, adjustmentSummary, language),
    coachReview: buildCoachReview(state, confidence, input, language),
    weekProtection: buildWeekProtection(state, input, language),
    weekJourney: buildWeekJourney(state, input, language),
    emptyState: buildEmptyState(state, input, language),
    confidence: confidenceLevel,
    lowAdherenceCard: buildLowAdherenceCard(state, input, language),
  };
}

function inferTrainingContractMeta(input: TrainingHomeViewStateInput): ScreenContractMeta {
  const reasonCodes = input.isGarminStale ? ['COACH_STALE'] : [];
  return buildScreenContractMeta({
    source: 'server',
    isFallback: reasonCodes.length > 0,
    isPartial: false,
    isStale: input.isGarminStale,
    reasonCodes,
  });
}

function classify(input: TrainingHomeViewStateInput & { adjustmentSummary: TrainingTodayAdjustmentSummary | null }): TrainingDayStateKind {
  if (normalizeStatus(input.todaySession?.status) === 'completed') return 'completed';
  if (!input.hasActivePlan && input.weekSessions.length === 0) return 'noPlan';
  if (hasConflictingSchedule(input.weekSessions, input.todaySession)) return 'conflictingSchedule';
  if (hasMissedSessionRecoveryState(input)) return 'missedSessionRecovery';
  if (!hasMeaningfulReadiness(input.readiness) && input.signals.length === 0 && !input.coachBriefing) {
    return 'insufficientData';
  }
  // Stale-Garmin (with or without a cached readiness) already funnels
  // through hasLowConfidenceState below → 'lowConfidence'. That IS the
  // intended degraded state for "we have a plan but the wearable data
  // the decision rests on is out of date" — see tests below. The
  // contract meta still carries the COACH_STALE reason code so the
  // client can render a trust banner.
  if (hasLowConfidenceState(input)) return 'lowConfidence';

  switch (input.adjustmentSummary?.tone) {
    case 'adjusted':
      return 'caution';
    case 'cautious':
    case 'limited':
      return 'recovery';
    case 'ready':
      return 'ready';
    default:
      break;
  }

  if (input.readiness) {
    const battery = normalizedBodyBattery(input.readiness.factors.bodyBattery);
    if (input.readiness.score <= 55 || (battery ?? 100) < 40) return 'recovery';
    if (input.readiness.score >= 74) return 'ready';
  }

  if (input.signals.some((signal) => signal.priority === 'urgent')) return 'caution';
  return 'ready';
}

function buildHero(
  state: TrainingDayStateKind,
  confidence: string,
  input: TrainingHomeViewStateInput,
  adjustmentSummary: TrainingTodayAdjustmentSummary | null,
  language: Lang,
): TodayRecommendationCardModel {
  const status = statusLabel(state, language);
  return {
    state,
    eyebrow: tPT(language, 'Hoje', 'Hoje', 'Today'),
    title: sessionHeadline(input.todaySession, state, language),
    subtitle: sessionSubtitle(input.todaySession, language),
    coachSentence: coachSentence(state, input, adjustmentSummary, language),
    statusLabel: status.label,
    statusTint: status.tint,
    readinessLabel: readinessLabel(input.readiness, state, language),
    confidenceLabel: confidence,
    primaryAction: primaryAction(state, language),
    secondaryAction: secondaryAction(state, language, input),
    supportingMetrics: heroMetrics(input.todaySession, language),
    originalPrescription: input.todayOriginalPrescription ?? null,
    adaptedPrescription: input.todayAdaptedPrescription ?? null,
  };
}

function buildReasoning(
  state: TrainingDayStateKind,
  confidence: string,
  input: TrainingHomeViewStateInput,
  adjustmentSummary: TrainingTodayAdjustmentSummary | null,
  language: Lang,
): CoachReasoningModel | null {
  const metrics = reasoningMetrics(
    input.readiness,
    input.weeklyAdherence,
    language,
    input.hasActivePlan,
    input.weekSessions.length,
  );
  const signals = reasoningSignals(state, input.signals, adjustmentSummary, language);
  if (metrics.length === 0 && signals.length === 0 && !adjustmentSummary) return null;

  return {
    title: tPT(language, 'Porque o coach decidiu assim', 'Por que o coach decidiu assim', 'Why the coach decided this'),
    summary: adjustmentSummary?.detail
      ?? localizedReadinessRecommendation(input.readiness?.recommendation, language)
      ?? tPT(
        language,
        'Os sinais de hoje foram combinados com o teu plano e a tua semana.',
        'Os sinais de hoje foram combinados com o seu plano e a sua semana.',
        "Today's signals were combined with your plan and week.",
      ),
    confidenceLabel: confidence,
    metrics,
    signals: signals.slice(0, 3),
  };
}

function buildCoachReview(
  state: TrainingDayStateKind,
  confidence: string,
  input: TrainingHomeViewStateInput,
  language: Lang,
): CoachReviewModel | null {
  if (state === 'noPlan') return null;

  if (input.coachBriefing) {
    const actionable = actionableRecommendations(input.coachBriefing.recommendations ?? []);
    const topRecommendation = actionable[0] ?? (input.coachBriefing.recommendations ?? [])[0] ?? null;
    const degraded = input.isGarminStale || input.coachBriefing.degraded === true || input.coachBriefing.cachedOnlyMiss === true;

    const summary = firstRenderable([
      topRecommendation?.summary ?? null,
      topRecommendation?.reason ?? null,
      input.coachBriefing.briefing,
    ]) ?? tPT(
      language,
      'O coach já leu o dia e encontrou uma próxima decisão para proteger a semana.',
      'O coach já leu o dia e encontrou uma próxima decisão para proteger a semana.',
      'The coach already read the day and found the next decision to protect the week.',
    );

    let detail: string;
    if (actionable.length > 0) {
      detail = actionable.length === 1
        ? tPT(
          language,
          'Há 1 recomendação pronta para aplicar sem perder a lógica da semana.',
          'Há 1 recomendação pronta para aplicar sem perder a lógica da semana.',
          'There is 1 recommendation ready to apply without losing the logic of the week.',
        )
        : tPT(
          language,
          `Há ${actionable.length} recomendações prontas para aplicar sem perder a lógica da semana.`,
          `Há ${actionable.length} recomendações prontas para aplicar sem perder a lógica da semana.`,
          `There are ${actionable.length} recommendations ready to apply without losing the logic of the week.`,
        );
    } else if (degraded) {
      detail = tPT(
        language,
        'A leitura veio com sinais incompletos, por isso vale rever antes de agir.',
        'A leitura veio com sinais incompletos, por isso vale rever antes de agir.',
        "This reading came with incomplete signals, so it's worth reviewing before acting.",
      );
    } else {
      detail = tPT(
        language,
        'A leitura já está pronta para te orientar sem precisares de reabrir o plano inteiro.',
        'A leitura já está pronta para te orientar sem precisares de reabrir o plano inteiro.',
        'The reading is ready to guide you without reopening the whole plan.',
      );
    }

    return {
      state: degraded ? 'degraded' : 'ready',
      title: tPT(language, 'Leitura do coach', 'Leitura do coach', 'Coach read'),
      summary: normalizeCoachReviewText(summary),
      detail,
      highlights: compactStrings([
        confidence,
        actionableHighlight(actionable.length, language),
        degraded ? degradedHighlight(language) : null,
      ]).slice(0, 3),
      primaryAction: actionable.length > 0
        ? {
          id: 'coach-review-apply',
          title: tPT(language, 'Aplicar recomendações', 'Aplicar recomendações', 'Apply recommendations'),
          subtitle: tPT(language, 'Atualizar o plano de hoje', 'Atualizar o plano de hoje', "Update today's plan"),
          icon: 'checkmark.circle.fill',
          tint: 'accent',
          target: 'applyCoachRecommendations',
          priority: 'primary',
        }
        : {
          id: 'coach-review-refresh',
          title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
          subtitle: tPT(language, 'Pedir uma leitura nova', 'Pedir uma leitura nova', 'Ask for a fresh read'),
          icon: 'arrow.clockwise',
          tint: 'accent',
          target: 'refreshCoach',
          priority: 'primary',
        },
      secondaryAction: {
        id: 'coach-review-open-week',
        title: tPT(language, 'Ver plano da semana', 'Ver plano da semana', 'See week plan'),
        subtitle: null,
        icon: 'calendar',
        tint: 'secretary',
        target: 'openWeekPlan',
        priority: 'secondary',
      },
    };
  }

  const hasCoachInputs = input.hasActivePlan || hasMeaningfulReadiness(input.readiness) || input.signals.length > 0;
  if (!hasCoachInputs) return null;

  return {
    state: 'needsRefresh',
    title: tPT(language, 'Puxa a leitura do coach', 'Puxa a leitura do coach', 'Pull the coach read'),
    summary: tPT(
      language,
      'Já há sinais suficientes para o coach transformar o dia numa recomendação mais clara.',
      'Já há sinais suficientes para o coach transformar o dia numa recomendação mais clara.',
      'There are enough signals for the coach to turn the day into a clearer recommendation.',
    ),
    detail: tPT(
      language,
      'Isto ajuda a proteger a sessão-chave, ajustar carga e explicar melhor o que mudou no plano.',
      'Isso ajuda a proteger a sessão-chave, ajustar carga e explicar melhor o que mudou no plano.',
      'This helps protect the key session, adjust load, and explain what changed in the plan.',
    ),
    highlights: compactStrings([
      confidence,
      hasMeaningfulReadiness(input.readiness) ? tPT(language, 'Sinais prontos', 'Sinais prontos', 'Signals ready') : null,
      input.hasActivePlan ? tPT(language, 'Plano ativo', 'Plano ativo', 'Active plan') : null,
    ]),
    primaryAction: {
      id: 'coach-review-request',
      title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
      subtitle: tPT(language, 'Gerar leitura do dia', 'Gerar leitura do dia', 'Generate day read'),
      icon: 'sparkles',
      tint: 'accent',
      target: 'refreshCoach',
      priority: 'primary',
    },
    secondaryAction: input.hasActivePlan
      ? {
        id: 'coach-review-plan',
        title: tPT(language, 'Ver plano da semana', 'Ver plano da semana', 'See week plan'),
        subtitle: null,
        icon: 'calendar',
        tint: 'secretary',
        target: 'openWeekPlan',
        priority: 'secondary',
      }
      : null,
  };
}

function buildWeekProtection(
  state: TrainingDayStateKind,
  input: TrainingHomeViewStateInput,
  language: Lang,
): WeekProtectionModel | null {
  if (!input.hasActivePlan) return null;

  const actionable = firstActionableRecommendation(input.coachBriefing?.recommendations ?? []);
  const protectedSession = protectedSessionFromWeek(input.weekSessions);
  const tomorrow = input.tomorrowSession;

  const summary = tomorrow && normalizeStatus(tomorrow.status) !== 'rest'
    ? tPT(
      language,
      `O ajuste de hoje protege ${sessionDisplayTitle(tomorrow, language).toLowerCase()} de amanhã e mantém a semana utilizável.`,
      `O ajuste de hoje protege ${sessionDisplayTitle(tomorrow, language).toLowerCase()} de amanhã e mantém a semana utilizável.`,
      `Today's adjustment protects tomorrow's ${sessionDisplayTitle(tomorrow, language).toLowerCase()} and keeps the week usable.`,
    )
    : protectedSession
      ? tPT(
        language,
        `Hoje foi coordenado para proteger ${sessionDisplayTitle(protectedSession, language).toLowerCase()} mais à frente na semana.`,
        `Hoje foi coordenado para proteger ${sessionDisplayTitle(protectedSession, language).toLowerCase()} mais à frente na semana.`,
        `Today was coordinated to protect ${sessionDisplayTitle(protectedSession, language).toLowerCase()} later in the week.`,
      )
      : tPT(
        language,
        'A decisão de hoje foi feita para preservar consistência e aderência semanal.',
        'A decisão de hoje foi feita para preservar consistência e aderência semanal.',
        "Today's decision was made to preserve weekly consistency and adherence.",
      );

  const impacts: string[] = [];
  if (tomorrow && normalizeStatus(tomorrow.status) !== 'rest') {
    const timeSuffix = tomorrow.time ? ` · ${tomorrow.time}` : '';
    impacts.push(
      tPT(
        language,
        `Amanhã: ${sessionDisplayTitle(tomorrow, language)}${timeSuffix}`,
        `Amanhã: ${sessionDisplayTitle(tomorrow, language)}${timeSuffix}`,
        `Tomorrow: ${sessionDisplayTitle(tomorrow, language)}${timeSuffix}`,
      ),
    );
  }
  if (weekActiveSessionCount(input.weekSessions) > 0) {
    const adherencePercent = Math.round(input.weeklyAdherence * 100);
    impacts.push(adherenceImpactLine(adherencePercent, language));
  }
  if (protectedSession && protectedSession.id !== tomorrow?.id) {
    impacts.push(
      tPT(
        language,
        `Sessão protegida: ${sessionDisplayTitle(protectedSession, language)}`,
        `Sessão protegida: ${sessionDisplayTitle(protectedSession, language)}`,
        `Protected session: ${sessionDisplayTitle(protectedSession, language)}`,
      ),
    );
  }

  // Collect deterministic kernel adjustments: every guardrail that
  // actually adjusted the plan. These are authoritative "what changed"
  // descriptions — independent of whether the LLM briefing happens to
  // be fresh. Cap at 5 so a noisy guardrail storm doesn't flood the UI.
  const kernelAdjustments = (input.kernelGuardrails ?? [])
    .filter((g) => g.adjusted && typeof g.message === 'string' && g.message.trim().length > 0)
    .slice(0, 5)
    .map((g) => formatKernelAdjustment(g, language));

  return {
    title: tPT(language, 'O que isto protege', 'O que isto protege', 'What this protects'),
    summary,
    changedFrom: actionable?.originalTitle ? localizedSessionType(actionable.originalTitle, language) : null,
    changedTo: actionable?.newTitle ? localizedSessionType(actionable.newTitle, language) : null,
    impactLines: impacts,
    kernelAdjustments,
    primaryAction: {
      id: 'week-protection-open-plan',
      title: tPT(language, 'Ver plano da semana', 'Ver plano da semana', 'See week plan'),
      subtitle: null,
      icon: 'calendar',
      tint: 'accent',
      target: 'openWeekPlan',
      priority: 'primary',
    },
    secondaryAction: state === 'noPlan' ? null : {
      id: 'week-protection-refresh',
      title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
      subtitle: null,
      icon: 'arrow.clockwise',
      tint: 'secretary',
      target: 'refreshCoach',
      priority: 'secondary',
    },
  };
}

function formatKernelAdjustment(guardrail: KernelGuardrailInput, language: Lang): string {
  const label = localizedKernelRuleLabel(guardrail.ruleId, language);
  const message = localizedKernelAdjustmentMessage(guardrail.message, language);
  return message ? `${label}: ${message}` : label;
}

function localizedKernelRuleLabel(ruleId: string, language: Lang): string {
  const normalized = ruleId.trim().toLowerCase();

  if (normalized.startsWith('interference_strength')) {
    return tPT(language, 'Conflito força/cardio', 'Conflito força/cardio', 'Strength/cardio conflict');
  }

  switch (normalized) {
    case 'readiness':
      return tPT(language, 'Prontidão', 'Prontidão', 'Readiness');
    case 'volume_growth':
      return tPT(language, 'Progressão de volume', 'Progressão de volume', 'Volume progression');
    case 'weekly_adherence':
    case 'adherence':
      return tPT(language, 'Aderência semanal', 'Aderência semanal', 'Weekly adherence');
    case 'focus_protection':
    case 'calendar_conflict':
      return tPT(language, 'Agenda protegida', 'Agenda protegida', 'Protected schedule');
    default:
      return humanizeKernelToken(ruleId);
  }
}

function localizedKernelAdjustmentMessage(message: string, language: Lang): string {
  const cleaned = message.trim().replace(/\s{2,}/g, ' ');
  const normalized = cleaned.toLowerCase();

  if (normalized.includes('strength maintenance conflicted with a key endurance day')) {
    return tPT(
      language,
      'A manutenção de força ficou perto demais de um dia-chave de endurance e foi movida ou suavizada.',
      'A manutenção de força ficou perto demais de um dia-chave de endurance e foi movida ou suavizada.',
      'Strength maintenance conflicted with a key endurance day and was moved or softened.',
    );
  }

  return cleaned.replace(/_/g, ' ');
}

function humanizeKernelToken(value: string): string {
  return value
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.length <= 3 ? word.toUpperCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

function buildWeekJourney(
  state: TrainingDayStateKind,
  input: TrainingHomeViewStateInput,
  language: Lang,
): WeekJourneyModel | null {
  if (input.weekSessions.length === 0) return null;
  const currentDay = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const days: WeekJourneyDay[] = input.weekSessions.map((session, index) => {
    const isToday = normalizeWeekday(session.day) === currentDay;
    let sessionState: WeekJourneyState;

    if (normalizeStatus(session.status) === 'completed') sessionState = 'completed';
    else if (normalizeStatus(session.status) === 'skipped') sessionState = 'missed';
    else if (normalizeStatus(session.status) === 'rest') sessionState = 'rest';
    else if (isToday && (state === 'caution' || state === 'recovery')) sessionState = 'adapted';
    else if (isToday) sessionState = 'today';
    else if (isRecoverySession(session)) sessionState = 'recovery';
    else if (isKeySession(session)) sessionState = 'key';
    else sessionState = 'planned';

    return {
      id: session.id ?? `${session.day}-${session.type}-${index}`,
      dayLabel: localizedWeekdayAbbreviation(session.day, language),
      title: sessionDisplayTitle(session, language),
      subtitle: session.time ?? null,
      state: sessionState,
    };
  });

  return {
    title: tPT(language, 'Jornada da semana', 'Jornada da semana', 'Week journey'),
    subtitle: tPT(
      language,
      'Onde estás agora e o que continua protegido',
      'Onde você está agora e o que continua protegido',
      'Where you are now and what stays protected',
    ),
    adherenceText: weekJourneyAdherenceText(input.weeklyAdherence, language),
    days,
  };
}

function buildEmptyState(
  state: TrainingDayStateKind,
  input: TrainingHomeViewStateInput,
  language: Lang,
): TrainingEmptyStateModel | null {
  if (state === 'noPlan') {
    return {
      title: tPT(language, 'Ainda não há plano a proteger', 'Ainda não há plano a proteger', "There isn't a plan to protect yet"),
      summary: tPT(
        language,
        'Antes de falar em progressão, precisamos da tua estrutura semanal e do teu objetivo.',
        'Antes de falar em progressão, precisamos da sua estrutura semanal e do seu objetivo.',
        'Before we talk progression, we need your weekly structure and goal.',
      ),
      detail: tPT(
        language,
        'Cria um plano para o coach começar a adaptar carga, aderência e recuperação.',
        'Crie um plano para o coach começar a adaptar carga, aderência e recuperação.',
        'Create a plan so the coach can start adapting load, adherence, and recovery.',
      ),
      action: {
        id: 'empty-create-plan',
        title: tPT(language, 'Criar plano', 'Criar plano', 'Create plan'),
        subtitle: tPT(language, 'Definir objetivo e disponibilidade', 'Definir objetivo e disponibilidade', 'Set goal and availability'),
        icon: 'calendar.badge.plus',
        tint: 'accent',
        target: 'createPlan',
        priority: 'primary',
      },
    };
  }

  if (state === 'insufficientData') {
    return {
      title: tPT(language, 'Faltam sinais para um ajuste melhor', 'Faltam sinais para um ajuste melhor', 'We need more signals for a better adjustment'),
      summary: tPT(
        language,
        'O treino continua visível, mas a confiança do coach está limitada.',
        'O treino continua visível, mas a confiança do coach está limitada.',
        'The workout is still visible, but the coach confidence is limited.',
      ),
      detail: tPT(
        language,
        'Liga Garmin ou Apple Health para desbloquear recomendações mais inteligentes.',
        'Conecte Garmin ou Apple Health para desbloquear recomendações mais inteligentes.',
        'Connect Garmin or Apple Health to unlock smarter recommendations.',
      ),
      action: {
        id: 'empty-open-integrations',
        title: tPT(language, 'Abrir integrações', 'Abrir integrações', 'Open integrations'),
        subtitle: null,
        icon: 'link.badge.plus',
        tint: 'secretary',
        target: 'openIntegrations',
        priority: 'primary',
      },
    };
  }

  if (state === 'lowConfidence') {
    return {
      title: tPT(language, 'Ainda falta confiança para fechar a leitura', 'Ainda falta confiança para fechar a leitura', 'We still need more confidence to lock the read'),
      summary: tPT(
        language,
        'O treino continua visível, mas vale rever sinais e leitura do coach antes de tratar isto como decisão final.',
        'O treino continua visível, mas vale rever sinais e leitura do coach antes de tratar isso como decisão final.',
        'The workout is still visible, but it is worth reviewing signals and the coach read before treating this as a final decision.',
      ),
      detail: tPT(
        language,
        'Atualiza o coach ou espera mais sinais antes de mexer no resto da semana com demasiada convicção.',
        'Atualize o coach ou espere mais sinais antes de mexer no resto da semana com convicção demais.',
        'Refresh the coach or wait for more signals before changing the rest of the week with too much conviction.',
      ),
      action: {
        id: 'empty-refresh-coach',
        title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
        subtitle: null,
        icon: 'arrow.clockwise',
        tint: 'accent',
        target: 'refreshCoach',
        priority: 'primary',
      },
    };
  }

  return null;
}

/**
 * Builds a supportive coaching card when weekly adherence drifts below
 * 60% and the user has an active plan to drift from. Suppressed in
 * bootstrap states (noPlan / insufficientData) where adherence is
 * meaningless, and on completed days where the card would just be
 * demoralizing retrospect.
 *
 * The three tip tiers below are a product-stance choice:
 *   - 40-59%: "We're drifting, let's salvage the week."
 *   - 20-39%: "Missed most sessions — reset, don't shame."
 *   -  0-19%: "Fresh start. One session this week is a win."
 */
function buildLowAdherenceCard(
  state: TrainingDayStateKind,
  input: TrainingHomeViewStateInput,
  language: Lang,
): LowAdherenceCoachingCardModel | null {
  if (!input.hasActivePlan) return null;
  if (state === 'noPlan' || state === 'insufficientData' || state === 'completed') return null;
  if (weekActiveSessionCount(input.weekSessions) === 0) return null;
  if (!Number.isFinite(input.weeklyAdherence) || input.weeklyAdherence >= 0.6) return null;

  const percent = Math.max(0, Math.min(100, Math.round(input.weeklyAdherence * 100)));
  const eyebrow = tPT(language, 'Esta semana', 'Esta semana', 'This week');
  const title = tPT(
    language,
    'A tua aderência escorregou — vamos recuperar o ritmo',
    'A sua aderência escorregou — vamos recuperar o ritmo',
    'Your adherence slipped — let\'s get the rhythm back',
  );

  let summary: string;
  let tip: string;

  if (percent >= 40) {
    summary = tPT(
      language,
      `Fizeste cerca de ${percent}% do que estava planeado. A semana ainda é salvável.`,
      `Você fez cerca de ${percent}% do que estava planejado. A semana ainda é salvável.`,
      `You finished about ${percent}% of what was planned. The week is still recoverable.`,
    );
    tip = tPT(
      language,
      'Escolhe UMA sessão-chave ainda esta semana — o coach ajusta o resto à volta.',
      'Escolha UMA sessão-chave ainda esta semana — o coach ajusta o resto em torno dela.',
      'Pick ONE key session still this week — the coach will adapt the rest around it.',
    );
  } else if (percent >= 20) {
    summary = tPT(
      language,
      `A execução ficou em ${percent}%. O plano precisa de um reset sem drama.`,
      `A execução ficou em ${percent}%. O plano precisa de um reset sem drama.`,
      `Execution landed at ${percent}%. The plan needs a low-drama reset.`,
    );
    tip = tPT(
      language,
      'Marca uma sessão fácil nos próximos 2 dias. Menos volume, mais regularidade.',
      'Agende uma sessão fácil nos próximos 2 dias. Menos volume, mais regularidade.',
      'Schedule an easy session in the next 2 days. Less volume, more regularity.',
    );
  } else {
    summary = tPT(
      language,
      `Quase zero execução esta semana. Sem julgamento — bora reiniciar pequeno.`,
      `Quase zero execução esta semana. Sem julgamento — vamos reiniciar pequeno.`,
      `Almost no execution this week. No judgement — let's restart small.`,
    );
    tip = tPT(
      language,
      'Uma sessão curta antes da próxima segunda já conta como vitória — foca só nisso.',
      'Uma sessão curta antes da próxima segunda já conta como vitória — foque só nisso.',
      'A single short session before next Monday already counts as a win — focus on just that.',
    );
  }

  return {
    eyebrow,
    title,
    summary,
    tip,
    adherencePercent: percent,
    primaryAction: {
      id: 'low-adherence-open-week',
      title: tPT(language, 'Ver semana', 'Ver semana', 'Open week plan'),
      subtitle: tPT(language, 'Reorganizar com o coach', 'Reorganizar com o coach', 'Reorganize with the coach'),
      icon: 'calendar.badge.clock',
      tint: 'accent',
      target: 'openWeekPlan',
      priority: 'primary',
    },
  };
}

function sessionHeadline(session: TrainingSessionInput | null, state: TrainingDayStateKind, language: Lang): string {
  switch (state) {
    case 'lowConfidence':
      return tPT(language, 'Revisão antes de insistir', 'Rever antes de insistir', 'Review before pushing');
    case 'missedSessionRecovery':
      return tPT(language, 'Retomar a semana com critério', 'Retomar a semana com critério', 'Reset the week with intent');
    case 'conflictingSchedule':
      return tPT(language, 'O dia precisa de reencaixe', 'O dia precisa de reencaixe', 'The day needs rescheduling');
    case 'noPlan':
      return tPT(language, 'Ainda sem plano de treino', 'Ainda sem plano de treino', 'No training plan yet');
    case 'completed':
      return tPT(language, 'Treino do dia concluído', 'Treino do dia concluído', "Today's workout completed");
    default:
      return session ? sessionDisplayTitle(session, language) : tPT(language, 'Descanso', 'Descanso', 'Rest');
  }
}

function sessionSubtitle(session: TrainingSessionInput | null, language: Lang): string {
  const parts = [session?.time ?? null, session?.duration != null ? `${session.duration} min` : null].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(' · ');
  return tPT(
    language,
    'O coach está a olhar para a tua semana, não só para hoje.',
    'O coach está olhando para a sua semana, não só para hoje.',
    'The coach is looking at your week, not only today.',
  );
}

function coachSentence(
  state: TrainingDayStateKind,
  input: TrainingHomeViewStateInput,
  adjustmentSummary: TrainingTodayAdjustmentSummary | null,
  language: Lang,
): string {
  if (adjustmentSummary?.detail) return adjustmentSummary.detail;
  if (input.readiness?.recommendation) return localizedReadinessRecommendation(input.readiness.recommendation, language);
  switch (state) {
    case 'ready':
      return tPT(language, 'Hoje parece um bom dia para executar o plano sem desperdiçar margem.', 'Hoje parece um bom dia para executar o plano sem desperdiçar margem.', 'Today looks like a good day to execute the plan without wasting margin.');
    case 'caution':
      return tPT(language, 'Vamos manter estímulo sem comprometer o resto da semana.', 'Vamos manter estímulo sem comprometer o resto da semana.', "We'll keep stimulus without compromising the rest of the week.");
    case 'recovery':
      return tPT(language, 'O objetivo hoje é preservar consistência antes de voltar a puxar carga.', 'O objetivo hoje é preservar consistência antes de voltar a puxar carga.', "Today's goal is to preserve consistency before pushing load again.");
    case 'lowConfidence':
      return tPT(language, 'Há treino visível, mas os sinais ainda não estão sólidos o suficiente para tratar isto como leitura final.', 'Há treino visível, mas os sinais ainda não estão sólidos o suficiente para tratar isso como leitura final.', 'There is a visible workout, but the signals are not solid enough yet to treat this as a final read.');
    case 'missedSessionRecovery':
      return tPT(language, 'Não vamos compensar tudo de uma vez. O foco agora é voltar ao trilho sem estragar o resto da semana.', 'Não vamos compensar tudo de uma vez. O foco agora é voltar ao trilho sem estragar o resto da semana.', 'We are not trying to make up everything at once. The goal now is getting back on track without damaging the rest of the week.');
    case 'conflictingSchedule':
      return tPT(language, 'Há um conflito real de encaixe hoje. Primeiro precisamos de encontrar a versão segura do dia.', 'Há um conflito real de encaixe hoje. Primeiro precisamos de encontrar a versão segura do dia.', 'There is a real scheduling conflict today. First we need to find the safe version of the day.');
    case 'completed':
      return tPT(language, 'O treino já conta para a semana. Agora o foco passa para recuperação e continuidade.', 'O treino já conta para a semana. Agora o foco passa para recuperação e continuidade.', 'The workout already counts for the week. Focus now shifts to recovery and continuity.');
    case 'noPlan':
      return tPT(language, 'Precisamos do teu objetivo e disponibilidade para o coach começar a coordenar bem.', 'Precisamos do seu objetivo e disponibilidade para o coach começar a coordenar bem.', 'We need your goal and availability before the coach can coordinate properly.');
    case 'insufficientData':
      return tPT(language, 'Há recomendação, mas com confiança limitada até chegarem melhores sinais.', 'Há recomendação, mas com confiança limitada até chegarem melhores sinais.', 'There is a recommendation, but with limited confidence until better signals arrive.');
  }
}

function statusLabel(state: TrainingDayStateKind, language: Lang): { label: string; tint: TrainingSemanticTint } {
  switch (state) {
    case 'ready':
      return { label: tPT(language, 'Pronto', 'Pronto', 'Ready'), tint: 'success' };
    case 'caution':
      return { label: tPT(language, 'Adaptado', 'Adaptado', 'Adapted'), tint: 'warning' };
    case 'recovery':
      return { label: tPT(language, 'Recuperação', 'Recuperação', 'Recovery'), tint: 'accent' };
    case 'lowConfidence':
      return { label: tPT(language, 'Confiança baixa', 'Confiança baixa', 'Low confidence'), tint: 'info' };
    case 'missedSessionRecovery':
      return { label: tPT(language, 'Retomar semana', 'Retomar semana', 'Reset week'), tint: 'warning' };
    case 'conflictingSchedule':
      return { label: tPT(language, 'Conflito de agenda', 'Conflito de agenda', 'Schedule conflict'), tint: 'warning' };
    case 'completed':
      return { label: tPT(language, 'Concluído', 'Concluído', 'Completed'), tint: 'success' };
    case 'noPlan':
      return { label: tPT(language, 'Sem plano', 'Sem plano', 'No plan'), tint: 'secretary' };
    case 'insufficientData':
      return { label: tPT(language, 'Confiança limitada', 'Confiança limitada', 'Limited confidence'), tint: 'info' };
  }
}

function readinessLabel(readiness: ReadinessInput | null, state: TrainingDayStateKind, language: Lang): string | null {
  if (!hasMeaningfulReadiness(readiness)) {
    return state === 'insufficientData' || state === 'lowConfidence'
      ? tPT(language, 'Sinais incompletos', 'Sinais incompletos', 'Incomplete signals')
      : null;
  }
  return tPT(language, `Prontidão ${readiness!.score}/100`, `Prontidão ${readiness!.score}/100`, `Readiness ${readiness!.score}/100`);
}

function heroMetrics(session: TrainingSessionInput | null, language: Lang): TrainingHeroMetric[] {
  const metrics: TrainingHeroMetric[] = [];
  if (session?.time) metrics.push({ id: 'time', label: tPT(language, 'Hora', 'Hora', 'Time'), value: session.time, icon: 'clock' });
  if (session?.duration != null) metrics.push({ id: 'duration', label: tPT(language, 'Duração', 'Duração', 'Duration'), value: `${session.duration} min`, icon: 'timer' });
  if (session?.exercises?.length) metrics.push({ id: 'sets', label: tPT(language, 'Exercícios', 'Exercícios', 'Exercises'), value: String(session.exercises.length), icon: 'list.bullet' });
  return metrics;
}

function primaryAction(state: TrainingDayStateKind, language: Lang): TrainingHeroActionModel {
  switch (state) {
    case 'completed':
      return {
        id: 'hero-open-week',
        title: tPT(language, 'Ver semana', 'Ver semana', 'See week'),
        subtitle: tPT(language, 'Como isto mexeu no resto do plano', 'Como isso mexeu no resto do plano', 'How this affected the rest of the plan'),
        icon: 'calendar',
        tint: 'accent',
        target: 'openWeekPlan',
        priority: 'primary',
      };
    case 'noPlan':
      return {
        id: 'hero-create-plan',
        title: tPT(language, 'Criar plano', 'Criar plano', 'Create plan'),
        subtitle: tPT(language, 'Começar estrutura e objetivo', 'Começar estrutura e objetivo', 'Start with structure and goal'),
        icon: 'calendar.badge.plus',
        tint: 'accent',
        target: 'createPlan',
        priority: 'primary',
      };
    case 'insufficientData':
      return {
        id: 'hero-open-integrations',
        title: tPT(language, 'Ligar sinais', 'Ligar sinais', 'Connect signals'),
        subtitle: tPT(language, 'Melhorar a leitura do coach', 'Melhorar a leitura do coach', 'Improve coach accuracy'),
        icon: 'link.badge.plus',
        tint: 'accent',
        target: 'openIntegrations',
        priority: 'primary',
      };
    case 'lowConfidence':
      return {
        id: 'hero-refresh-low-confidence',
        title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
        subtitle: tPT(language, 'Pedir uma leitura mais segura', 'Pedir uma leitura mais segura', 'Ask for a safer read'),
        icon: 'arrow.clockwise',
        tint: 'accent',
        target: 'refreshCoach',
        priority: 'primary',
      };
    case 'missedSessionRecovery':
    case 'conflictingSchedule':
      return {
        id: 'hero-open-week',
        title: tPT(language, 'Rever semana', 'Rever semana', 'Review week'),
        subtitle: tPT(language, 'Reencaixar o plano com menos atrito', 'Reencaixar o plano com menos atrito', 'Reshape the plan with less friction'),
        icon: 'calendar',
        tint: 'accent',
        target: 'openWeekPlan',
        priority: 'primary',
      };
    default:
      return {
        id: 'hero-complete',
        title: tPT(language, 'Concluir', 'Concluir', 'Complete'),
        subtitle: tPT(language, 'Registar execução e aderência', 'Registrar execução e aderência', 'Log execution and adherence'),
        icon: 'checkmark.circle.fill',
        tint: 'accent',
        target: 'completeSession',
        priority: 'primary',
      };
  }
}

function secondaryAction(
  state: TrainingDayStateKind,
  language: Lang,
  input: TrainingHomeViewStateInput,
): TrainingHeroActionModel | null {
  switch (state) {
    case 'completed':
    case 'noPlan':
      return null;
    case 'insufficientData':
      return {
        id: 'hero-refresh',
        title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
        subtitle: null,
        icon: 'arrow.clockwise',
        tint: 'secretary',
        target: 'refreshCoach',
        priority: 'secondary',
      };
    case 'lowConfidence':
      return {
        id: 'hero-open-week-low-confidence',
        title: tPT(language, 'Ver plano da semana', 'Ver plano da semana', 'See week plan'),
        subtitle: null,
        icon: 'calendar',
        tint: 'secretary',
        target: 'openWeekPlan',
        priority: 'secondary',
      };
    case 'missedSessionRecovery':
      return input.todaySession
        ? {
          id: 'hero-complete-recovery',
          title: tPT(language, 'Concluir o que ficou para hoje', 'Concluir o que ficou para hoje', 'Complete today’s session'),
          subtitle: null,
          icon: 'checkmark.circle.fill',
          tint: 'secretary',
          target: 'completeSession',
          priority: 'secondary',
        }
        : null;
    case 'conflictingSchedule':
      return {
        id: 'hero-refresh-conflict',
        title: tPT(language, 'Atualizar coach', 'Atualizar coach', 'Refresh coach'),
        subtitle: null,
        icon: 'arrow.clockwise',
        tint: 'secretary',
        target: 'refreshCoach',
        priority: 'secondary',
      };
    default:
      return {
        id: 'hero-skip',
        title: tPT(language, 'Não consegui fazer', 'Não consegui fazer', 'Could not do it'),
        subtitle: null,
        icon: 'xmark.circle',
        tint: 'secretary',
        target: 'skipSession',
        priority: 'secondary',
      };
  }
}

function reasoningMetrics(
  readiness: ReadinessInput | null,
  adherence: number,
  language: Lang,
  hasActivePlan: boolean,
  weekSessionCount: number,
): TrainingReasoningMetric[] {
  const metrics: TrainingReasoningMetric[] = [];
  if (readiness) {
    if (typeof readiness.factors.sleepScore === 'number') {
      const sleep = readiness.factors.sleepScore;
      metrics.push({
        id: 'sleep',
        label: tPT(language, 'Sono', 'Sono', 'Sleep'),
        value: String(sleep),
        tint: sleep >= 70 ? 'success' : sleep >= 50 ? 'warning' : 'error',
      });
    }
    if (readiness.factors.hrvStatus) {
      const hrv = readiness.factors.hrvStatus;
      metrics.push({
        id: 'hrv',
        label: 'HRV',
        value: hrv,
        tint: hrv.toLowerCase().includes('low') ? 'warning' : 'success',
      });
    }
    const battery = normalizedBodyBattery(readiness.factors.bodyBattery);
    if (typeof battery === 'number') {
      metrics.push({
        id: 'battery',
        label: tPT(language, 'Body Battery', 'Body Battery', 'Body Battery'),
        value: `${battery}%`,
        tint: battery >= 60 ? 'success' : battery >= 35 ? 'warning' : 'error',
      });
    }
  }

  if (hasActivePlan || weekSessionCount > 0 || adherence > 0) {
    metrics.push({
      id: 'adherence',
      label: tPT(language, 'Aderência', 'Aderência', 'Adherence'),
      ...adherenceMetricPresentation(adherence, language),
    });
  }
  return metrics.slice(0, 4);
}

function adherenceMetricPresentation(
  adherence: number,
  language: Lang,
): Pick<TrainingReasoningMetric, 'value' | 'tint'> {
  const percent = Number.isFinite(adherence)
    ? Math.max(0, Math.min(100, Math.round(adherence * 100)))
    : 0;
  if (percent <= 0) {
    return {
      value: tPT(language, 'Reinício', 'Recomeço', 'Start'),
      tint: 'info',
    };
  }
  return {
    value: `${percent}%`,
    tint: adherence >= 0.8 ? 'success' : adherence >= 0.6 ? 'warning' : 'warning',
  };
}

function adherenceImpactLine(adherencePercent: number, language: Lang): string {
  if (adherencePercent <= 0) {
    return tPT(
      language,
      'Aderência: semana pronta para reiniciar com uma sessão simples.',
      'Aderência: semana pronta para recomeçar com uma sessão simples.',
      'Adherence: ready to restart with one simple session this week.',
    );
  }
  return tPT(
    language,
    `Aderência semanal em ${adherencePercent}%`,
    `Aderência semanal em ${adherencePercent}%`,
    `Weekly adherence at ${adherencePercent}%`,
  );
}

function weekJourneyAdherenceText(adherence: number, language: Lang): string {
  const percent = Number.isFinite(adherence)
    ? Math.max(0, Math.min(100, Math.round(adherence * 100)))
    : 0;
  if (percent <= 0) {
    return tPT(
      language,
      'Pronto para reiniciar esta semana',
      'Pronto para recomeçar esta semana',
      'Ready to restart this week',
    );
  }
  return `${percent}% ${tPT(language, 'aderência semanal', 'aderência semanal', 'weekly adherence')}`;
}

function reasoningSignals(
  state: TrainingDayStateKind,
  signals: TrainingSignalInput[],
  adjustmentSummary: TrainingTodayAdjustmentSummary | null,
  language: Lang,
): TrainingReasoningSignal[] {
  const sortedSignals = [...signals].sort((lhs, rhs) => priorityScore(rhs.priority) - priorityScore(lhs.priority));
  if (sortedSignals.length > 0) {
    return sortedSignals.map((signal) => ({
      id: String(signal.id),
      title: localizedSignalTitle(signal, language),
      effect: signalEffectText(state, language),
      detail: localizedSignalSummary(signal, language),
      timestamp: relativeTime(signal.createdAt, language),
      tone: signalTone(signal, state),
    }));
  }

  if (!adjustmentSummary) return [];
  return adjustmentSummary.chips.map((chip) => ({
    id: chip,
    title: chip,
    effect: adjustmentSummary.detail,
    detail: null,
    timestamp: null,
    tone: state === 'ready' ? 'supportive' : 'protective',
  }));
}

/**
 * Compute the structured confidence bucket for the current read.
 *
 * Rules (pinned by unit tests):
 *   - Stale wearable data or a degraded coach briefing forces 'low' —
 *     even if we have plenty of signal, the client needs to know the
 *     read is untrustworthy.
 *   - Meaningful readiness + at least one cross-skill signal ⇒ 'high'.
 *   - Any one of readiness / signals / a live coach briefing ⇒ 'medium'.
 *   - Otherwise 'low' (cold start, no wearable, no briefing).
 */
function computeConfidenceLevel(
  input: TrainingHomeViewStateInput & { adjustmentSummary: TrainingTodayAdjustmentSummary | null },
): TrainingHomeConfidenceLevel {
  if (input.isGarminStale || input.coachBriefing?.degraded === true) return 'low';
  if (hasMeaningfulReadiness(input.readiness) && input.signals.length > 0) return 'high';
  if (hasMeaningfulReadiness(input.readiness) || input.signals.length > 0 || input.coachBriefing) return 'medium';
  return 'low';
}

/** Localize the confidence bucket for display. */
function labelForConfidence(level: TrainingHomeConfidenceLevel, language: Lang): string {
  switch (level) {
  case 'high':
    return tPT(language, 'Alta confiança', 'Alta confiança', 'High confidence');
  case 'medium':
    return tPT(language, 'Confiança média', 'Confiança média', 'Medium confidence');
  case 'low':
  default:
    return tPT(language, 'Baixa confiança', 'Baixa confiança', 'Low confidence');
  }
}

function resolveAdjustmentSummary(
  input: TrainingHomeViewStateInput,
  language: Lang,
): TrainingTodayAdjustmentSummary | null {
  const hasMeaningfulInput = hasMeaningfulReadiness(input.readiness) || !!input.coachBriefing || input.signals.length > 0 || input.isGarminStale;
  if (!hasMeaningfulInput) return null;

  const causePhrases = dedupedCausePhrases(input.readiness, input.signals, language);
  const causeChips = dedupedCauseChips(input.readiness, input.signals, language);

  // Gap 6: the Garmin-specific copy below names Garmin literally. Firing it
  // for `coachBriefing.degraded` alone (without Garmin being a data source
  // for this user) lied to Gmail-only / Outlook-only users that Garmin was
  // stale when they had never connected it. We now fire this branch ONLY
  // when `isGarminStale` is genuinely true (caller already gates that on
  // `isGarminActivelyIntegrated` — see training-home-payload.ts). Other
  // degraded signals (coachBriefing.degraded for non-Garmin reasons,
  // cachedOnlyMiss) fall through to the next summary branches or to the
  // generic degraded UI owned by Agent 4 via `meta.isStale` + `reasonCodes`.
  if (input.isGarminStale) {
    return {
      title: tPT(language, 'Leitura parcial de hoje', 'Leitura parcial de hoje', "Today's read is partial"),
      detail: tPT(
        language,
        'O plano de hoje continua visível, mas o briefing está a usar dados limitados até o Garmin voltar a sincronizar.',
        'O plano de hoje continua visível, mas o briefing está usando dados limitados até o Garmin voltar a sincronizar.',
        "Today's plan is still visible, but the briefing is running on limited data until Garmin syncs again.",
      ),
      tone: 'limited',
      chips: causeChips.slice(0, 3),
    };
  }

  // Fallback: briefing is degraded but not because of Garmin. Use
  // provider-agnostic copy so we don't blame Garmin for an outage that
  // might be Gemini / network / cached-only-miss.
  if (input.coachBriefing?.degraded === true || input.coachBriefing?.cachedOnlyMiss === true) {
    return {
      title: tPT(language, 'Leitura parcial de hoje', 'Leitura parcial de hoje', "Today's read is partial"),
      detail: tPT(
        language,
        'O plano de hoje continua visível, mas o briefing está a usar dados limitados enquanto os sinais recuperam.',
        'O plano de hoje continua visível, mas o briefing está usando dados limitados enquanto os sinais recuperam.',
        "Today's plan is still visible, but the briefing is running on limited data while signals recover.",
      ),
      tone: 'limited',
      chips: causeChips.slice(0, 3),
    };
  }

  if (firstActionableRecommendation(input.coachBriefing?.recommendations ?? [])) {
    const detail = causePhrases.length > 0
      ? tPT(language, `O coach mexeu no treino de hoje por causa de ${joinPhrases(causePhrases.slice(0, 3), language)}.`, `O coach mexeu no treino de hoje por causa de ${joinPhrases(causePhrases.slice(0, 3), language)}.`, `The coach adjusted today's training because of ${joinPhrases(causePhrases.slice(0, 3), language)}.`)
      : tPT(
        language,
        'O coach mexeu na sessão de hoje para proteger a recuperação e manter a semana no bom trilho.',
        'O coach mexeu na sessão de hoje para proteger a recuperação e manter a semana no bom trilho.',
        "The coach adjusted today's session to protect recovery and keep the week on track.",
      );
    return {
      title: tPT(language, 'Hoje ajustado', 'Hoje ajustado', 'Today adjusted'),
      detail,
      tone: 'adjusted',
      chips: causeChips.slice(0, 3),
    };
  }

  if (requiresMargin(input.readiness, input.signals)) {
    const detail = causePhrases.length > 0
      ? tPT(language, `Os sinais de hoje pedem margem por causa de ${joinPhrases(causePhrases.slice(0, 3), language)}.`, `Os sinais de hoje pedem margem por causa de ${joinPhrases(causePhrases.slice(0, 3), language)}.`, `Today's signals call for a little margin because of ${joinPhrases(causePhrases.slice(0, 3), language)}.`)
      : tPT(
        language,
        'A recuperação de hoje pede alguma margem antes de puxares pela sessão.',
        'A recuperação de hoje pede alguma margem antes de puxar a sessão.',
        "Today's recovery calls for a bit of margin before pushing the session.",
      );
    return {
      title: tPT(language, 'Leva o dia com margem', 'Leva o dia com margem', 'Give today some margin'),
      detail,
      tone: 'cautious',
      chips: causeChips.slice(0, 3),
    };
  }

  if (looksReady(input.readiness, input.signals)) {
    const positives = dedupedPositivePhrases(input.readiness, language);
    const detail = positives.length > 0
      ? tPT(language, `A recuperação e os sinais de hoje estão estáveis, com ${joinPhrases(positives.slice(0, 2), language)}.`, `A recuperação e os sinais de hoje estão estáveis, com ${joinPhrases(positives.slice(0, 2), language)}.`, `Recovery and today's signals look steady, with ${joinPhrases(positives.slice(0, 2), language)}.`)
      : tPT(
        language,
        'Sem alertas grandes agora — hoje parece um bom dia para seguir o plano.',
        'Sem alertas grandes agora — hoje parece um bom dia para seguir o plano.',
        'No major red flags right now — today looks good for staying on plan.',
      );
    return {
      title: tPT(language, 'Bom dia para seguir o plano', 'Bom dia para seguir o plano', 'Good day to stay on plan'),
      detail,
      tone: 'ready',
      chips: causeChips.slice(0, 3),
    };
  }

  return {
    title: tPT(language, 'Plano estável hoje', 'Plano estável hoje', 'Plan looks steady today'),
    detail: tPT(
      language,
      'Sem alertas grandes agora — o plano de hoje está alinhado com a tua recuperação e a tua agenda.',
      'Sem alertas grandes agora — o plano de hoje está alinhado com a sua recuperação e a sua agenda.',
      "No major alerts right now — today's plan is aligned with your recovery and schedule.",
    ),
    tone: 'steady',
    chips: causeChips.slice(0, 3),
  };
}

function hasMeaningfulReadiness(readiness: ReadinessInput | null): boolean {
  if (!readiness) return false;
  const factors = readiness.factors;
  return readiness.score > 0
    || typeof factors.sleepScore === 'number'
    || typeof normalizedBodyBattery(factors.bodyBattery) === 'number'
    || typeof factors.restingHeartRate === 'number'
    || !!trimmed(factors.hrvStatus)
    || !!trimmed(factors.trainingLoad)
    || !!trimmed(factors.stressLevel)
    || !!trimmed(readiness.recommendation);
}

function normalizeStatus(value?: string | null): string {
  return trimmed(value).toLowerCase();
}

function weekActiveSessionCount(weekSessions: WeekSessionInput[]): number {
  return weekSessions.filter((session) => {
    const status = normalizeStatus(session.status);
    return status !== ''
      && status !== 'rest'
      && status !== 'completed'
      && status !== 'skipped'
      && status !== 'cancelled'
      && status !== 'deferred'
      && status !== 'superseded';
  }).length;
}

function normalizedBodyBattery(value?: number | null): number | null {
  if (typeof value !== 'number' || value <= 0) return null;
  return Math.round(value);
}

function actionableRecommendations(recommendations: CoachRecommendationInput[]): CoachRecommendationInput[] {
  return recommendations.filter((recommendation) => recommendation.action?.toUpperCase() !== 'KEEP' && !!recommendation.eventId);
}

function firstActionableRecommendation(recommendations: CoachRecommendationInput[]): CoachRecommendationInput | null {
  return actionableRecommendations(recommendations)[0] ?? null;
}

function firstRenderable(values: Array<string | null | undefined>): string | null {
  return values
    .map((value) => trimmed(value))
    .find((value) => value.length > 0) ?? null;
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => trimmed(value))
    .filter((value) => value.length > 0);
}

function actionableHighlight(count: number, language: Lang): string | null {
  if (count <= 0) return null;
  if (count === 1) {
    return tPT(language, '1 recomendação pronta', '1 recomendação pronta', '1 recommendation ready');
  }
  return tPT(language, `${count} recomendações prontas`, `${count} recomendações prontas`, `${count} recommendations ready`);
}

function degradedHighlight(language: Lang): string {
  return tPT(language, 'Modo degradado', 'Modo degradado', 'Degraded mode');
}

function normalizeCoachReviewText(text: string): string {
  return trimmed(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ');
}

function localizedSessionType(raw: string, language: Lang): string {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return raw;
  if (!isPortuguese(language)) return raw;

  const normalized = trimmedRaw.toLowerCase();
  if (normalized === 'rest' || normalized === 'rest day') return 'Descanso';
  if (normalized === 'recovery') return 'Recuperação';

  const patterns: Array<[RegExp, string]> = [
    [/\blong\s+conditioning\s+session\b/gi, 'Sessão longa de condicionamento'],
    [/\bconditioning\s+session\b/gi, 'Sessão de condicionamento'],
    [/\bmobility\s*\+\s*recovery\b/gi, 'Mobilidade + recuperação'],
    [/\bcore\s+support\b/gi, 'Core de suporte'],
    [/\bkey\s+session\b/gi, 'Sessão-chave'],
    [/\bfitness\s+baseline\s+test\b/gi, 'Teste de base física'],
    [/\bno\s+training\b/gi, 'Sem treino'],
    [/\bupper\s+body\s+strength\b/gi, 'Força de tronco superior'],
    [/\blower\s+body\s+strength\b/gi, 'Força de pernas'],
    [/\btrack\s+intervals\b/gi, 'Intervalos de pista'],
    [/\btempo\s+ride\b/gi, 'Treino tempo de bicicleta'],
    [/\btempo\s+run\b/gi, 'Corrida tempo'],
    [/\blong\s+run\b/gi, 'Corrida longa'],
    [/\beasy\s+run\b/gi, 'Corrida fácil'],
    [/\brecovery\s+swim\b/gi, 'Natação de recuperação'],
    [/\brecovery\s+ride\b/gi, 'Bicicleta de recuperação'],
    [/\brecovery\s+run\b/gi, 'Corrida de recuperação'],
    [/\bactive\s+recovery\b/gi, 'Recuperação ativa'],
    [/\bupper\s+body\b/gi, 'Tronco superior'],
    [/\blower\s+body\b/gi, 'Pernas'],
    [/\brest\s+day\b/gi, 'Descanso'],
    [/\bstrength\b/gi, 'Força'],
    [/\bgym\b/gi, 'Ginásio'],
    [/\bcycling\b/gi, 'Ciclismo'],
    [/\bcycle\b/gi, 'Ciclismo'],
    [/\bbike\b/gi, 'Bicicleta'],
    [/\bride\b/gi, 'Saída de bicicleta'],
    [/\bswim\b/gi, 'Natação'],
    [/\brun\b/gi, 'Corrida'],
  ];

  let localized = trimmedRaw;
  for (const [pattern, replacement] of patterns) {
    localized = localized.replace(pattern, replacement);
  }
  return localized.replace(/\b(\d+)\s*[kK]\b/g, '$1 km').replace(/\s{2,}/g, ' ').trim();
}

function sessionDisplayTitle(
  session: Pick<TrainingSessionInput, 'type' | 'sessionType'> & { title?: string | null },
  language: Lang,
): string {
  const preferred = [session.title, session.type, session.sessionType]
    .map((value) => trimmed(value))
    .find((value): value is string => !!value);
  return localizedSessionType(preferred ?? session.type, language);
}

function localizedWeekdayAbbreviation(raw: string, language: Lang): string {
  switch (normalizeWeekday(raw)) {
    case 'monday': return isPortuguese(language) ? 'Seg' : 'Mon';
    case 'tuesday': return isPortuguese(language) ? 'Ter' : 'Tue';
    case 'wednesday': return isPortuguese(language) ? 'Qua' : 'Wed';
    case 'thursday': return isPortuguese(language) ? 'Qui' : 'Thu';
    case 'friday': return isPortuguese(language) ? 'Sex' : 'Fri';
    case 'saturday': return isPortuguese(language) ? 'Sáb' : 'Sat';
    case 'sunday': return isPortuguese(language) ? 'Dom' : 'Sun';
    default: return raw;
  }
}

function localizedReadinessRecommendation(raw: string | null | undefined, language: Lang): string {
  const trimmedRaw = trimmed(raw);
  if (!trimmedRaw || !isPortuguese(language)) return trimmedRaw;
  return trimmedRaw
    .replace(/^below baseline\s+[—-]\s+reduce volume by ~?25%\s+or swap for easy session\.$/gi, 'Abaixo da linha de base — reduz o volume em ~25% ou troca por uma sessão leve.')
    .replace(/^slightly fatigued\s+[—-]\s+reduce intensity by ~?10%\.$/gi, 'Ligeiramente fatigado — reduz a intensidade em ~10%.')
    .replace(/\bslightly fatigued\b/gi, 'Ligeiramente fatigado')
    .replace(/\bvery fatigued\b/gi, 'Muito fatigado')
    .replace(/\bready to push\b/gi, 'Pronto para puxar')
    .replace(/\bstay on plan\b/gi, 'Mantém o plano')
    .replace(/\bprioritize recovery today\b/gi, 'Prioriza a recuperação hoje')
    .replace(/\bconsider a quality session\b/gi, 'considera uma sessão de qualidade')
    .replace(/reduce intensity by ~?10%/gi, 'reduz a intensidade em ~10%')
    .replace(/\bkeep the planned session\b/gi, 'mantém a sessão planeada')
    .replace(/\btake it easy today\b/gi, 'leva o dia com margem');
}

function requiresMargin(readiness: ReadinessInput | null, signals: TrainingSignalInput[]): boolean {
  if (signals.some(isMarginSignal)) return true;
  if (!readiness) return false;
  const bodyBattery = normalizedBodyBattery(readiness.factors.bodyBattery);
  return (readiness.score > 0 && readiness.score <= 50)
    || (readiness.factors.sleepScore ?? 100) < 65
    || (bodyBattery ?? 100) < 45
    || containsElevatedLoad(readiness.factors.trainingLoad)
    || containsElevatedStress(readiness.factors.stressLevel)
    || containsLowMarker(readiness.factors.hrvStatus);
}

function looksReady(readiness: ReadinessInput | null, signals: TrainingSignalInput[]): boolean {
  if (!signals.every((signal) => !isMarginSignal(signal))) return false;
  if (!readiness) return signals.length === 0;
  const bodyBattery = normalizedBodyBattery(readiness.factors.bodyBattery);
  return readiness.score >= 65
    || (readiness.factors.sleepScore ?? 0) >= 75
    || (bodyBattery ?? 0) >= 60;
}

function dedupedCausePhrases(readiness: ReadinessInput | null, signals: TrainingSignalInput[], language: Lang): string[] {
  const phrases: string[] = [];
  if (readiness) {
    const bodyBattery = normalizedBodyBattery(readiness.factors.bodyBattery);
    if ((readiness.factors.sleepScore ?? 100) < 65) phrases.push(tPT(language, 'pouco sono', 'pouco sono', 'light sleep'));
    if ((bodyBattery ?? 100) < 45) phrases.push(tPT(language, 'Body Battery baixa', 'Body Battery baixa', 'low Body Battery'));
    if (containsLowMarker(readiness.factors.hrvStatus)) phrases.push(tPT(language, 'HRV baixa', 'HRV baixa', 'low HRV'));
    if (containsElevatedLoad(readiness.factors.trainingLoad)) phrases.push(tPT(language, 'carga alta', 'carga alta', 'high load'));
    if (containsElevatedStress(readiness.factors.stressLevel)) phrases.push(tPT(language, 'stress alto', 'stress alto', 'high stress'));
  }

  for (const signal of signals.slice(0, 4)) {
    switch (signal.type) {
      case 'low_sleep': phrases.push(tPT(language, 'pouco sono', 'pouco sono', 'light sleep')); break;
      case 'low_hrv': phrases.push(tPT(language, 'HRV baixa', 'HRV baixa', 'low HRV')); break;
      case 'low_readiness': phrases.push(tPT(language, 'prontidão baixa', 'prontidão baixa', 'low readiness')); break;
      case 'high_leg_load': phrases.push(tPT(language, 'carga alta nas pernas', 'carga alta nas pernas', 'heavy leg load')); break;
      case 'high_shoulder_load': phrases.push(tPT(language, 'ombros ainda carregados', 'ombros ainda carregados', 'heavy shoulder load')); break;
      case 'calendar_conflict': phrases.push(tPT(language, 'sobreposição com a agenda', 'sobreposição com a agenda', 'calendar overlap')); break;
      case 'planned_race_this_week': phrases.push(tPT(language, 'corrida importante esta semana', 'corrida importante esta semana', 'race week')); break;
      default: break;
    }
  }
  return dedupeStrings(phrases);
}

function dedupedCauseChips(readiness: ReadinessInput | null, signals: TrainingSignalInput[], language: Lang): string[] {
  const chips: string[] = [];
  if (readiness) {
    const bodyBattery = normalizedBodyBattery(readiness.factors.bodyBattery);
    if ((readiness.factors.sleepScore ?? 100) < 65) chips.push(tPT(language, 'Sono baixo', 'Sono baixo', 'Low sleep'));
    if ((bodyBattery ?? 100) < 45) chips.push(tPT(language, 'Body Battery baixa', 'Body Battery baixa', 'Low Body Battery'));
    if (containsLowMarker(readiness.factors.hrvStatus)) chips.push(tPT(language, 'HRV baixa', 'HRV baixa', 'Low HRV'));
    if (containsElevatedLoad(readiness.factors.trainingLoad)) chips.push(tPT(language, 'Carga alta', 'Carga alta', 'High load'));
    if (containsElevatedStress(readiness.factors.stressLevel)) chips.push(tPT(language, 'Stress alto', 'Stress alto', 'High stress'));
  }
  chips.push(...signals.slice(0, 4).map((signal) => localizedSignalTitle(signal, language)));
  return dedupeStrings(chips);
}

function dedupedPositivePhrases(readiness: ReadinessInput | null, language: Lang): string[] {
  if (!readiness) return [];
  const phrases: string[] = [];
  const bodyBattery = normalizedBodyBattery(readiness.factors.bodyBattery);
  if ((readiness.factors.sleepScore ?? 0) >= 75) phrases.push(tPT(language, 'sono consistente', 'sono consistente', 'steady sleep'));
  if ((bodyBattery ?? 0) >= 60) phrases.push(tPT(language, 'Body Battery estável', 'Body Battery estável', 'steady Body Battery'));
  if (readiness.score >= 70) phrases.push(tPT(language, 'prontidão alta', 'prontidão alta', 'high readiness'));
  return dedupeStrings(phrases);
}

function localizedSignalTitle(signal: TrainingSignalInput, language: Lang): string {
  if (!isPortuguese(language)) return signal.title;
  switch (signal.type) {
    case 'low_sleep': return 'Pouco sono';
    case 'low_hrv': return 'HRV baixa';
    case 'low_readiness': return 'Prontidão baixa';
    case 'high_leg_load': return 'Carga alta nas pernas';
    case 'high_shoulder_load': return 'Carga alta nos ombros';
    case 'gym_load_today': return 'Ginásio hoje';
    case 'running_load_today': return 'Corrida hoje';
    case 'cycling_load_today': return 'Bicicleta hoje';
    case 'swim_load_today': return 'Natação hoje';
    case 'planned_hard_run': return 'Corrida dura planeada';
    case 'planned_hard_ride': return 'Saída dura planeada';
    case 'planned_race_this_week': return 'Prova esta semana';
    case 'training_session_scheduled': return 'Sessão marcada';
    case 'calendar_conflict': return 'Conflito no calendário';
    case 'low_adherence': return 'Aderência baixa';
    case 'high_adherence': return 'Aderência alta';
    case 'plan_drift': return 'Desvio ao plano';
    default: return localizedSessionType(signal.title, language);
  }
}

function localizedSignalSummary(signal: TrainingSignalInput, language: Lang): string {
  if (!isPortuguese(language)) return signal.summary;
  const payload = signal.payload ?? {};
  switch (signal.type) {
    case 'low_sleep': {
      const scoreText = typeof payload.score === 'number' ? `score ${payload.score}` : 'score baixo';
      const hoursText = typeof payload.total_hours === 'number' ? ` (${formatDecimal(payload.total_hours, language)}h)` : '';
      return `${scoreText}${hoursText} — o coach vai baixar a intensidade de hoje.`;
    }
    case 'low_hrv': {
      const deltaText = typeof payload.delta_pct === 'number' ? `${Math.round(payload.delta_pct)}%` : 'abaixo da linha de base';
      return `HRV ${deltaText} face à média de 7 dias — espera trabalho mais leve hoje.`;
    }
    case 'low_readiness':
      return typeof payload.score === 'number'
        ? `Prontidão Garmin ${payload.score}/100 — o coach vai cortar qualquer sessão dura planeada.`
        : 'Prontidão Garmin baixa — o coach vai cortar qualquer sessão dura planeada.';
    case 'high_leg_load': {
      const rpeText = typeof payload.rpe === 'number' ? ` (RPE ${payload.rpe})` : '';
      return `Sessão exigente de ${localizedSport(payload.source, language)} recentemente${rpeText} — amanhã as pernas ficam mais leves.`;
    }
    case 'high_shoulder_load': {
      const rpeText = typeof payload.rpe === 'number' ? ` (RPE ${payload.rpe})` : '';
      return `Trabalho exigente de ombros${rpeText} — o coach de natação vai reduzir a carga de pull.`;
    }
    case 'gym_load_today': {
      const rpeText = typeof payload.rpe === 'number' ? `RPE ${payload.rpe}` : 'sessão registada';
      return `Ginásio ${rpeText} hoje — os outros coaches vão contar com isso amanhã.`;
    }
    case 'running_load_today': {
      const rpeText = typeof payload.rpe === 'number' ? `RPE ${payload.rpe}` : 'sessão registada';
      const distanceText = typeof payload.distance_km === 'number' ? `, ${formatDecimal(payload.distance_km, language)} km` : '';
      return `Corrida ${rpeText}${distanceText} hoje — as sessões de pernas ajustam amanhã.`;
    }
    case 'cycling_load_today': {
      const rpeText = typeof payload.rpe === 'number' ? `RPE ${payload.rpe}` : 'sessão registada';
      return `Bicicleta ${rpeText} hoje — os outros coaches vão contar com isso.`;
    }
    case 'swim_load_today': {
      const rpeText = typeof payload.rpe === 'number' ? `RPE ${payload.rpe}` : 'sessão registada';
      return `Natação ${rpeText} hoje — isto entra na gestão semanal da carga dos ombros.`;
    }
    case 'planned_hard_run':
      return 'Há uma corrida dura marcada — os outros desportos ficam mais leves à volta dela.';
    case 'planned_hard_ride':
      return 'Há uma saída dura marcada — ginásio e corrida ficam mais leves à volta dela.';
    case 'planned_race_this_week':
      return 'Tens uma prova no calendário nos próximos 7 dias — os coaches vão afinar a carga.';
    case 'training_session_scheduled': {
      const sportText = localizedSport(payload.sport, language);
      const titleText = typeof payload.title === 'string' ? `: ${localizedSessionType(payload.title, language)}` : '';
      return `Sessão de ${sportText}${titleText} — já está no calendário.`;
    }
    case 'calendar_conflict': {
      const event = typeof payload.conflict_event_title === 'string' ? payload.conflict_event_title : 'este evento';
      return `"${event}" sobrepõe-se a uma sessão de treino marcada — considera mover uma das duas.`;
    }
    case 'low_adherence': {
      const completed = typeof payload.completed === 'number' ? payload.completed : 0;
      const planned = typeof payload.planned === 'number' ? payload.planned : 0;
      const pct = typeof payload.adherence_pct === 'number' ? Math.round(payload.adherence_pct) : 0;
      return `${completed}/${planned} sessões esta semana (${pct}%) — o coach vai ajustar o plano ou acompanhar.`;
    }
    case 'high_adherence': {
      const completed = typeof payload.completed === 'number' ? payload.completed : 0;
      const planned = typeof payload.planned === 'number' ? payload.planned : 0;
      return `${completed}/${planned} sessões concluídas esta semana — o coach pode subir a carga.`;
    }
    case 'plan_drift': {
      const dominant = localizedSport(payload.dominant_sport, language);
      const planSport = localizedSport(payload.plan_sport, language);
      const pct = typeof payload.drift_pct === 'number' ? `${Math.round(payload.drift_pct)}%` : 'a maior parte';
      return `${pct} das sessões nas últimas 4 semanas foram de ${dominant} — isso está a afastar-te do plano de ${planSport}.`;
    }
    default:
      return signal.summary;
  }
}

function signalEffectText(state: TrainingDayStateKind, language: Lang): string {
  switch (state) {
    case 'lowConfidence':
      return tPT(language, 'Ainda pede confirmação', 'Ainda pede confirmação', 'Still needs confirmation');
    case 'missedSessionRecovery':
      return tPT(language, 'Pede recuperar aderência sem exagero', 'Pede recuperar aderência sem exagero', 'Calls for adherence recovery without overdoing it');
    case 'conflictingSchedule':
      return tPT(language, 'Mostra onde o dia precisa de reencaixe', 'Mostra onde o dia precisa de reencaixe', 'Shows where the day needs rescheduling');
    case 'ready':
      return tPT(language, 'Apoia manter o plano', 'Apoia manter o plano', 'Supports staying on plan');
    case 'completed':
      return tPT(language, 'Já influenciou a decisão de hoje', 'Já influenciou a decisão de hoje', "Already influenced today's call");
    case 'noPlan':
      return tPT(language, 'Ainda não há plano para reagir a este sinal', 'Ainda não há plano para reagir a este sinal', 'There is no plan yet to react to this signal');
    case 'insufficientData':
      return tPT(language, 'Sinal visto com contexto limitado', 'Sinal visto com contexto limitado', 'Signal seen with limited context');
    case 'caution':
    case 'recovery':
      return tPT(language, 'Empurra o coach para proteger a semana', 'Empurra o coach para proteger a semana', 'Pushes the coach to protect the week');
  }
}

function signalTone(signal: TrainingSignalInput, state: TrainingDayStateKind): TrainingReasoningTone {
  if (signal.priority === 'urgent' || state === 'recovery' || state === 'caution' || state === 'conflictingSchedule' || state === 'missedSessionRecovery') return 'protective';
  if (state === 'ready') return 'supportive';
  return 'caution';
}

function hasLowConfidenceState(input: TrainingHomeViewStateInput): boolean {
  const degradedBriefing = input.coachBriefing?.degraded === true || input.coachBriefing?.cachedOnlyMiss === true;
  return degradedBriefing || (input.isGarminStale && (input.hasActivePlan || input.weekSessions.length > 0 || !!input.todaySession));
}

function hasMissedSessionRecoveryState(input: TrainingHomeViewStateInput): boolean {
  const skippedToday = normalizeStatus(input.todaySession?.status) === 'skipped';
  const skippedThisWeek = input.weekSessions.some((session) => normalizeStatus(session.status) === 'skipped');
  return (skippedToday || skippedThisWeek) && input.weeklyAdherence < 0.75;
}

function hasConflictingSchedule(weekSessions: WeekSessionInput[], _todaySession: TrainingSessionInput | null): boolean {
  const grouped = new Map<string, Array<{ time?: string | null; duration?: number | null }>>();
  for (const session of weekSessions) {
    if (normalizeStatus(session.status) === 'rest') continue;
    const key = normalizeWeekday(session.day);
    const items = grouped.get(key) ?? [];
    items.push({ time: session.time, duration: session.duration ?? null });
    grouped.set(key, items);
  }

  for (const sessions of grouped.values()) {
    if (sessions.length < 2) continue;
    const timed = sessions
      .map((session) => ({
        startMinutes: parseClockMinutes(session.time),
        duration: session.duration ?? 45,
      }))
      .filter((session): session is { startMinutes: number; duration: number } => typeof session.startMinutes === 'number')
      .sort((left, right) => left.startMinutes - right.startMinutes);

    for (let index = 1; index < timed.length; index += 1) {
      const previous = timed[index - 1]!;
      const current = timed[index]!;
      if (current.startMinutes < previous.startMinutes + Math.max(previous.duration, 30)) {
        return true;
      }
    }
  }

  return false;
}

function parseClockMinutes(raw: string | null | undefined): number | null {
  const value = trimmed(raw);
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
}

function protectedSessionFromWeek(weekSessions: WeekSessionInput[]): WeekSessionInput | null {
  return weekSessions.find((session) => normalizeStatus(session.status) === 'planned' && isKeySession(session)) ?? null;
}

function isKeySession(session: Pick<WeekSessionInput, 'title' | 'type'>): boolean {
  const text = `${session.title ?? ''} ${session.type}`.toLowerCase();
  return text.includes('key session')
    || text.includes('long run')
    || text.includes('threshold')
    || text.includes('tempo')
    || text.includes('interval')
    || text.includes('brick');
}

function isRecoverySession(session: Pick<WeekSessionInput, 'title' | 'type'>): boolean {
  const text = `${session.title ?? ''} ${session.type}`.toLowerCase();
  return text.includes('recovery') || text.includes('descanso') || text.includes('rest');
}

function containsLowMarker(value?: string | null): boolean {
  const normalized = trimmed(value).toLowerCase();
  return normalized.includes('low') || normalized.includes('baixo') || normalized.includes('poor');
}

function containsElevatedLoad(value?: string | null): boolean {
  const normalized = trimmed(value).toLowerCase();
  return normalized.includes('1.3') || normalized.includes('high') || normalized.includes('alto') || normalized.includes('elev');
}

function containsElevatedStress(value?: string | null): boolean {
  const normalized = trimmed(value).toLowerCase();
  return normalized.includes('high') || normalized.includes('alto') || normalized.includes('elev');
}

function isMarginSignal(signal: TrainingSignalInput): boolean {
  return [
    'low_sleep',
    'low_hrv',
    'low_readiness',
    'high_leg_load',
    'high_shoulder_load',
    'calendar_conflict',
    'planned_race_this_week',
    'low_adherence',
    'plan_drift',
  ].includes(signal.type);
}

function localizedSport(raw: unknown, language: Lang): string {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (normalized) {
    case 'run':
    case 'running':
    case 'corrida':
      return isPortuguese(language) ? 'corrida' : 'running';
    case 'ride':
    case 'bike':
    case 'cycling':
    case 'cycle':
    case 'ciclismo':
      return isPortuguese(language) ? 'bicicleta' : 'cycling';
    case 'swim':
    case 'swimming':
    case 'natacao':
    case 'natação':
      return isPortuguese(language) ? 'natação' : 'swimming';
    case 'gym':
    case 'strength':
    case 'forca':
    case 'força':
      return isPortuguese(language) ? 'ginásio' : 'gym';
    default:
      return normalized || (isPortuguese(language) ? 'treino' : 'training');
  }
}

function relativeTime(rawDate: string, language: Lang): string | null {
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) return tPT(language, 'agora', 'agora', 'now');
  if (diffMinutes < 60) return tPT(language, `há ${diffMinutes} min`, `há ${diffMinutes} min`, `${diffMinutes}m ago`);
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return tPT(language, `há ${diffHours} h`, `há ${diffHours} h`, `${diffHours}h ago`);
  const diffDays = Math.round(diffHours / 24);
  return tPT(language, `há ${diffDays} d`, `há ${diffDays} d`, `${diffDays}d ago`);
}

function formatDecimal(value: number, language: Lang): string {
  return new Intl.NumberFormat(isPortuguese(language) ? (language === 'pt-BR' ? 'pt-BR' : 'pt-PT') : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
}

function normalizeWeekday(raw: string): string {
  return raw.trim().toLowerCase();
}

function priorityScore(priority: TrainingSignalInput['priority']): number {
  switch (priority) {
    case 'urgent': return 3;
    case 'normal': return 2;
    case 'background': return 1;
  }
}

function joinPhrases(phrases: string[], language: Lang): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) {
    return isPortuguese(language)
      ? `${phrases[0]} e ${phrases[1]}`
      : `${phrases[0]} and ${phrases[1]}`;
  }
  const last = phrases[phrases.length - 1];
  const lead = phrases.slice(0, -1).join(', ');
  return isPortuguese(language) ? `${lead} e ${last}` : `${lead}, and ${last}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = trimmed(value).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function trimmed(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPortuguese(language: Lang): boolean {
  return language.startsWith('pt');
}

function tPT(language: Lang, ptPT: string, ptBR: string, en: string): string {
  if (language === 'pt-BR') return ptBR;
  if (language.startsWith('pt')) return ptPT;
  return en;
}
