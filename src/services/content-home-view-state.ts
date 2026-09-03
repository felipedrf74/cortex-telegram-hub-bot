// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ScreenContractMeta } from './screen-contract-meta';
import { buildScreenContractMeta } from './screen-contract-meta';
import type { Lang } from '../utils/i18n';
import type { ContentWorkPlanStatus } from './cross-agent-learning';

export type ContentHomeStageKind =
  | 'noIdeaYet'
  | 'angleChosen'
  | 'scriptInProgress'
  | 'readyToFilm'
  | 'scheduled'
  | 'emptyPipeline'
  | 'crossSkillOpportunity'
  | 'backlogOverload'
  | 'learningAvailable'
  | 'lowConfidence';

export type ContentHomeActionTarget =
  | 'radar'
  | 'scriptGenerator'
  | 'schedule'
  | 'tasks'
  | 'pipeline'
  | 'learnings'
  | 'voiceDNA'
  | 'captureNote';

export type ContentSemanticTint = 'info' | 'content' | 'accent' | 'success' | 'warning';
export type ContentReasoningTone = 'opportunity' | 'supportive' | 'caution';
export type ContentFlowStatus = 'complete' | 'current' | 'pending' | 'blocked';

export interface ContentHeroActionModel {
  title: string;
  icon: string;
  target: ContentHomeActionTarget;
}

export interface NextBestActionHeroModel {
  eyebrow: string;
  title: string;
  subtitle: string;
  summary: string;
  currentStage: string;
  confidence: string;
  state: ContentHomeStageKind;
  primaryAction: ContentHeroActionModel;
  secondaryAction: ContentHeroActionModel | null;
}

export interface CreativeReasoningSignal {
  id: string;
  title: string;
  effect: string;
  detail: string | null;
  tone: ContentReasoningTone;
}

export interface CreativeReasoningModel {
  title: string;
  summary: string;
  confidence: string;
  signals: CreativeReasoningSignal[];
}

export interface FlowStatusStep {
  id: string;
  title: string;
  summary: string;
  status: ContentFlowStatus;
}

export interface FlowStatusModel {
  title: string;
  steps: FlowStatusStep[];
}

export interface PrioritizedActionModel {
  id: string;
  title: string;
  summary: string;
  impact: string;
  estimatedEffort: string;
  target: ContentHomeActionTarget;
  tint: ContentSemanticTint;
}

export interface PipelineHealthMetric {
  id: string;
  label: string;
  value: string;
  tint: ContentSemanticTint;
}

export interface PipelineHealthModel {
  title: string;
  summary: string;
  metrics: PipelineHealthMetric[];
  publicationTracking: ContentHomePublicationTrackingUnavailable;
}

export interface ContentHomePublicationTrackingUnavailable {
  availability: 'unavailable';
  reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED';
  publicationExecution: 'not_supported';
}

export interface ContentEmptyStateModel {
  title: string;
  detail: string;
  action: ContentHeroActionModel;
}

export interface ContentHomeViewState {
  meta: ScreenContractMeta;
  hero: NextBestActionHeroModel;
  workSchedule: ContentHomeWorkScheduleModel;
  reasoning: CreativeReasoningModel | null;
  flow: FlowStatusModel;
  actions: PrioritizedActionModel[];
  pipelineHealth: PipelineHealthModel;
  emptyState: ContentEmptyStateModel | null;
}

export interface ContentHomeIdeaDigest {
  title: string;
}

export interface ContentHomeTopicDigest {
  status: 'planned' | 'drafting' | 'ready' | 'published' | 'cancelled';
  scheduledDate: string | null;
}

export interface ContentHomeWorkScheduleDigest {
  confirmedThisWeek: number;
  attentionThisWeek: number;
  authorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
  semantics: 'private_work_session';
}

export interface ContentHomeWorkScheduleModel extends ContentHomeWorkScheduleDigest {
  authority: 'secretary';
  planStatus: ContentWorkPlanStatus;
}

export interface ContentHomePipelineInput {
  stages: {
    ideas: ContentHomeIdeaDigest[];
    scripted: ContentHomeIdeaDigest[];
    filmed: ContentHomeIdeaDigest[];
    editing: ContentHomeIdeaDigest[];
    published: ContentHomeIdeaDigest[];
  };
  publicationTracking: ContentHomePublicationTrackingUnavailable;
}

export interface ContentHomeSignalDigest {
  title: string;
  summary: string;
}

export interface ContentHomeDeskItemDigest {
  title: string;
  body: string;
}

export interface ContentHomePillarSummary {
  name: string;
}

export interface ContentHomeBuildInput {
  pipeline: ContentHomePipelineInput | null;
  ideas: ContentHomeIdeaDigest[];
  topics: ContentHomeTopicDigest[];
  workSchedule?: ContentHomeWorkScheduleDigest | null;
  discovery: {
    activeCount: number;
    deskReadyCount: number;
    deskItems: ContentHomeDeskItemDigest[];
    monitoredPillars: ContentHomePillarSummary[];
  } | null;
  script: {
    voicePatternCount: number;
    hasBrandVoice: boolean;
  } | null;
  optimization: {
    activeInsightCount: number;
    recentSignals: ContentHomeSignalDigest[];
  } | null;
  filmingRecommendation: {
    date: string;
    confidence: string;
    localizedReason: string;
    localizedConfidenceLabel: string;
  } | null;
  hasAttemptedLoad: boolean;
  lastLoadError: string | null;
  meta?: ScreenContractMeta | null;
}

interface Snapshot {
  pipelineIdeas: number;
  scripted: number;
  filmed: number;
  editing: number;
  directIdeas: number;
  deadlineTopics: number;
  scheduledWorkBlocks: number;
  scheduleAttention: number;
  readyTopics: number;
  draftingTopics: number;
  deskReady: number;
  monitoredPillars: number;
  optimizationSignals: number;
  voicePatterns: number;
  hasVoiceDNA: boolean;
  activeDiscoverySignals: number;
  totalOpenWork: number;
  hasAnyData: boolean;
}

export function buildContentHomeViewState(
  input: ContentHomeBuildInput,
  language: Lang,
): ContentHomeViewState {
  const snapshot = makeSnapshot(input);
  const state = resolveState(input, snapshot);

  return {
    meta: buildContentContractMeta(input),
    hero: buildHero(state, input, snapshot, language),
    workSchedule: buildWorkScheduleModel(input),
    reasoning: buildReasoning(state, input, snapshot, language),
    flow: buildFlow(state, snapshot, language),
    actions: buildActions(state, input, snapshot, language),
    pipelineHealth: buildPipelineHealth(state, snapshot, language),
    emptyState: buildEmptyState(state, input, snapshot, language),
  };
}

function buildContentContractMeta(input: ContentHomeBuildInput): ScreenContractMeta {
  const meta = input.meta ?? inferContentContractMeta(input);
  const authorityStatus = input.workSchedule?.authorityStatus ?? 'unavailable';
  if (authorityStatus === 'current') return meta;

  return buildScreenContractMeta({
    ...meta,
    isPartial: true,
    reasonCodes: [
      ...meta.reasonCodes,
      authorityStatus === 'unavailable'
        ? 'CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE'
        : 'CONTENT_SCHEDULE_AUTHORITY_PARTIAL',
    ],
  });
}

function buildWorkScheduleModel(
  input: ContentHomeBuildInput,
): ContentHomeWorkScheduleModel {
  const workSchedule = input.workSchedule ?? {
    confirmedThisWeek: 0,
    attentionThisWeek: 0,
    authorityStatus: 'unavailable' as const,
    semantics: 'private_work_session' as const,
  };
  return {
    ...workSchedule,
    authority: 'secretary',
    planStatus: resolveContentWorkPlanStatus(input),
  };
}

function resolveContentWorkPlanStatus(input: ContentHomeBuildInput): ContentWorkPlanStatus {
  const workSchedule = input.workSchedule;
  if (!workSchedule || workSchedule.authorityStatus === 'unavailable') return 'unavailable';
  if (workSchedule.authorityStatus === 'partially_unavailable') return 'partial';
  if (workSchedule.confirmedThisWeek > 0) return 'confirmed';
  // Attention-only cancellation/provider states are not work proposals. A
  // proposal requires an actionable filming recommendation that still needs
  // Secretary confirmation.
  if (input.filmingRecommendation != null) return 'proposed';
  return 'unplanned';
}

function inferContentContractMeta(input: ContentHomeBuildInput): ScreenContractMeta {
  const reasonCodes = input.lastLoadError ? ['CONTENT_HOME_LOAD_FAILED'] : [];
  return buildScreenContractMeta({
    source: 'server',
    isFallback: reasonCodes.length > 0,
    isPartial: reasonCodes.length > 0,
    isStale: false,
    reasonCodes,
  });
}

function makeSnapshot(input: ContentHomeBuildInput): Snapshot {
  const pipelineIdeas = input.pipeline?.stages.ideas.length ?? 0;
  const scripted = input.pipeline?.stages.scripted.length ?? 0;
  const filmed = input.pipeline?.stages.filmed.length ?? 0;
  const editing = input.pipeline?.stages.editing.length ?? 0;
  const activeTopics = input.topics.filter((topic) => !isTerminalTopic(topic.status)).length;
  const deadlineTopics = input.topics.filter((topic) => !isTerminalTopic(topic.status) && topic.scheduledDate != null).length;
  // Topics are a compatibility projection over the same canonical workspace
  // items as pipeline. Use them only as a fallback when the canonical pipeline
  // digest is unavailable, otherwise the Home backlog counts every item twice.
  const readyTopics = input.pipeline == null
    ? input.topics.filter((topic) => topic.status === 'ready').length
    : 0;
  const draftingTopics = input.pipeline == null
    ? input.topics.filter((topic) => topic.status === 'drafting').length
    : 0;
  const scheduledWorkBlocks = input.workSchedule?.confirmedThisWeek ?? 0;
  const scheduleAttention = input.workSchedule?.attentionThisWeek ?? 0;

  const deskReady = input.discovery?.deskReadyCount ?? 0;
  const monitoredPillars = input.discovery?.monitoredPillars.length ?? 0;
  const optimizationSignals = input.optimization?.recentSignals.length ?? input.optimization?.activeInsightCount ?? 0;
  const voicePatterns = input.script?.voicePatternCount ?? 0;
  const hasVoiceDNA = input.script?.hasBrandVoice ?? false;
  const activeDiscoverySignals = input.discovery?.activeCount ?? 0;

  const pipelineOpenWork = pipelineIdeas + scripted + filmed + editing;
  const totalOpenWork = input.pipeline == null
    ? Math.max(activeTopics, input.ideas.length)
    : pipelineOpenWork;
  const hasAnyData =
    pipelineIdeas + scripted + filmed + editing + input.ideas.length + input.topics.length
      + deskReady + monitoredPillars + optimizationSignals + scheduledWorkBlocks + scheduleAttention > 0;

  return {
    pipelineIdeas,
    scripted,
    filmed,
    editing,
    directIdeas: input.ideas.length,
    deadlineTopics,
    scheduledWorkBlocks,
    scheduleAttention,
    readyTopics,
    draftingTopics,
    deskReady,
    monitoredPillars,
    optimizationSignals,
    voicePatterns,
    hasVoiceDNA,
    activeDiscoverySignals,
    totalOpenWork,
    hasAnyData,
  };
}

function resolveState(input: ContentHomeBuildInput, snapshot: Snapshot): ContentHomeStageKind {
  const matureExecutionCount = snapshot.scripted + snapshot.readyTopics + snapshot.filmed + snapshot.editing;
  const hasMatureExecutionStep = matureExecutionCount > 0;

  if (snapshot.totalOpenWork >= 7 && matureExecutionCount > 1) {
    return 'backlogOverload';
  }

  if (snapshot.scheduledWorkBlocks > 0 && !hasMatureExecutionStep && snapshot.draftingTopics === 0) {
    return 'scheduled';
  }

  if (input.filmingRecommendation?.confidence !== 'low'
    && !hasMatureExecutionStep
    && (snapshot.deskReady > 0 || snapshot.monitoredPillars > 0 || snapshot.activeDiscoverySignals > 0)
    && !!input.filmingRecommendation) {
    return 'crossSkillOpportunity';
  }

  if (input.filmingRecommendation?.confidence === 'low' && hasMatureExecutionStep) {
    return 'lowConfidence';
  }

  if (hasMatureExecutionStep) {
    return 'readyToFilm';
  }

  if (snapshot.optimizationSignals > 0) {
    return 'learningAvailable';
  }

  if (snapshot.hasAnyData && snapshot.totalOpenWork === 0) {
    return 'emptyPipeline';
  }

  if (snapshot.directIdeas > 0 || snapshot.pipelineIdeas > 0 || snapshot.deskReady > 0 || snapshot.totalOpenWork > 0) {
    return 'scriptInProgress';
  }

  if (snapshot.monitoredPillars > 0 || snapshot.activeDiscoverySignals > 0) {
    return 'angleChosen';
  }

  return 'noIdeaYet';
}

function buildHero(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  snapshot: Snapshot,
  language: Lang,
): NextBestActionHeroModel {
  const candidateTitle = preferredIdeaTitle(input, language);
  const filmingDate = input.filmingRecommendation ? shortDate(input.filmingRecommendation.date, language) : null;
  const schedulePlanIsProposed = (input.filmingRecommendation != null || isScheduleDecisionState(state))
    && scheduleDecisionRequiresReview(input, state);
  const workPlanStatus = resolveContentWorkPlanStatus(input);
  const hasConfirmedPlanAttention = workPlanStatus === 'confirmed' && snapshot.scheduleAttention > 0;
  const scheduleDecisionConfidence = schedulePlanIsProposed
    ? t(language, 'Revisão necessária', 'Review required')
    : null;

  switch (state) {
    case 'noIdeaYet':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Abrir o radar para encontrar o próximo tema', 'Open radar to find the next topic'),
        subtitle: t(language, 'Descoberta ainda vazia', 'Discovery still empty'),
        summary: t(language, 'Ainda não há um tema forte em movimento. O melhor próximo passo é puxar um sinal novo antes de abrir roteiro, agenda ou backlog.', 'There is not a strong topic in motion yet. The best next step is pulling a fresh signal before opening script, schedule, or backlog.'),
        currentStage: t(language, 'Radar por iniciar', 'Radar not started'),
        confidence: t(language, 'Confiança média', 'Medium confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
        secondaryAction: { title: t(language, 'Capturar nota', 'Capture note'), icon: 'square.and.pencil', target: 'captureNote' },
      };
    case 'angleChosen':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Validar o ângulo antes de escrever', 'Validate the angle before writing'),
        subtitle: t(language, 'Sinal encontrado · confiança média', 'Signal found · medium confidence'),
        summary: tPT(language, 'Já há um sinal ou pilar a mexer. Vale fechar o ângulo certo agora para o roteiro nascer com direção.', 'Já existe um sinal ou pilar em movimento. Vale fechar o ângulo certo agora para o roteiro nascer com direção.', 'A signal or pillar is already moving. It is worth locking the right angle now so the script starts with direction.'),
        currentStage: t(language, 'Ângulo em definição', 'Angle being defined'),
        confidence: t(language, 'Confiança média', 'Medium confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
        secondaryAction: { title: t(language, 'Abrir Voice DNA', 'Open Voice DNA'), icon: 'waveform', target: 'voiceDNA' },
      };
    case 'scriptInProgress':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, `Transformar “${candidateTitle}” em roteiro`, `Turn “${candidateTitle}” into a script`),
        subtitle: t(language, 'Radar validado · confiança alta', 'Radar validated · high confidence'),
        summary: t(language, 'Este tema já tem sinal suficiente para avançar. O ganho agora vem de escrever antes de abrir mais frentes.', 'This topic already has enough signal to move. The gain now comes from writing before opening more fronts.'),
        currentStage: t(language, 'Roteiro por escrever', 'Script pending'),
        confidence: t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Continuar roteiro', 'Continue script'), icon: 'wand.and.stars', target: 'scriptGenerator' },
        secondaryAction: { title: t(language, 'Ver pipeline', 'View pipeline'), icon: 'square.stack.3d.up.fill', target: 'pipeline' },
      };
    case 'readyToFilm':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Preparar a gravação do próximo conteúdo', 'Prepare the next filming block'),
        subtitle: filmingDate
          ? t(language, `Janela sugerida · ${filmingDate}`, `Suggested window · ${filmingDate}`)
          : t(language, 'Roteiro pronto para avançar', 'Script ready to move'),
        summary: input.filmingRecommendation?.localizedReason
          ?? t(language, 'O sistema já vê maturidade suficiente para propor uma sessão privada à Secretary; a recomendação ainda não reserva tempo.', 'The system sees enough maturity to propose a private session to Secretary; the recommendation does not reserve time yet.'),
        currentStage: t(language, 'Pronto para filmar', 'Ready to film'),
        confidence: scheduleDecisionConfidence
          ?? input.filmingRecommendation?.localizedConfidenceLabel
          ?? t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir agenda', 'Open schedule'), icon: 'calendar', target: 'schedule' },
        secondaryAction: { title: t(language, 'Ver pipeline', 'View pipeline'), icon: 'square.stack.3d.up.fill', target: 'pipeline' },
      };
    case 'scheduled':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: hasConfirmedPlanAttention
          ? tPT(language, 'Mantém o bloco confirmado e revê a atenção da agenda', 'Mantenha o bloco confirmado e revise a atenção da agenda', 'Keep the confirmed block and review schedule attention')
          : schedulePlanIsProposed
            ? tPT(language, 'Rever o bloco confirmado e o estado do plano', 'Revisar o bloco confirmado e o estado do plano', 'Review the confirmed block and plan status')
            : tPT(language, 'Proteger o bloco de trabalho já confirmado', 'Proteger o bloco de trabalho já confirmado', 'Protect the confirmed work block'),
        subtitle: hasConfirmedPlanAttention
          ? t(language, 'Sessão privada confirmada · atenção da agenda pendente', 'Private work session confirmed · schedule attention pending')
          : schedulePlanIsProposed
            ? t(language, `Estado do plano: ${workPlanStatus} · revisão necessária`, `Plan status: ${workPlanStatus} · review required`)
            : t(language, 'Sessão privada já agendada', 'Private work session scheduled'),
        summary: hasConfirmedPlanAttention
          ? tPT(
              language,
              'O bloco privado confirmado continua protegido pela verdade local da Secretary, enquanto a sincronização ou outro estado da agenda precisa de atenção. Isto não agenda nem executa a publicação.',
              'O bloco privado confirmado continua protegido pela verdade local do Secretário, enquanto a sincronização ou outro estado da agenda precisa de atenção. Isso não agenda nem executa a publicação.',
              'The confirmed private block remains protected by current Secretary truth while provider sync or another schedule state needs attention. This does not schedule or execute publication.',
            )
          : schedulePlanIsProposed
            ? tPT(
                language,
                `Existe um bloco privado confirmado, mas o estado global do plano é ${workPlanStatus}. Só o bloco confirmado está protegido; isto não agenda nem executa a publicação.`,
                `Existe um bloco privado confirmado, mas o estado geral do plano é ${workPlanStatus}. Apenas o bloco confirmado está protegido; isso não agenda nem executa a publicação.`,
                `A confirmed private block is visible, but the overall plan status is ${workPlanStatus}. Only the confirmed block is protected; this does not schedule or execute publication.`,
              )
            : tPT(language, 'O trabalho de conteúdo já tem um bloco privado confirmado. Revê o objetivo e os bloqueios; isto não agenda nem executa a publicação.', 'O trabalho de conteúdo já tem um bloco privado confirmado. Revise o objetivo e os bloqueios; isso não agenda nem executa a publicação.', 'Content work has a confirmed private block. Review its objective and blockers; this does not schedule or execute publication.'),
        currentStage: hasConfirmedPlanAttention
          ? t(language, 'Bloco confirmado · atenção pendente', 'Confirmed block · attention pending')
          : schedulePlanIsProposed
            ? t(language, `Plano ${workPlanStatus}`, `Plan ${workPlanStatus}`)
            : t(language, 'Bloco de trabalho confirmado', 'Work block confirmed'),
        confidence: schedulePlanIsProposed
          ? t(language, 'Revisão necessária', 'Review required')
          : t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir agenda', 'Open schedule'), icon: 'calendar', target: 'schedule' },
        secondaryAction: { title: t(language, 'Ver pipeline', 'View pipeline'), icon: 'square.stack.3d.up.fill', target: 'pipeline' },
      };
    case 'emptyPipeline':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Voltar a abrir o pipeline com um novo tema', 'Reopen the pipeline with a new topic'),
        subtitle: t(language, 'Pipeline vazio', 'Pipeline empty'),
        summary: tPT(language, 'Há histórico no sistema, mas não há nenhuma peça ativa agora. O próximo ganho é repor movimento com um tema novo e intencional.', 'Há histórico no sistema, mas não há nenhuma peça ativa agora. O próximo ganho é repor movimento com um tema novo e intencional.', 'There is history in the system, but there is no active piece right now. The next gain is restoring motion with a fresh intentional topic.'),
        currentStage: t(language, 'Pipeline por reabrir', 'Pipeline needs reopening'),
        confidence: t(language, 'Confiança média', 'Medium confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
        secondaryAction: { title: t(language, 'Abrir aprendizagens', 'Open learnings'), icon: 'chart.line.uptrend.xyaxis', target: 'learnings' },
      };
    case 'crossSkillOpportunity':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Aproveitar a janela cruzada desta semana', 'Use this week’s cross-skill window'),
        subtitle: t(language, 'Oportunidade detectada pelo sistema', 'System-detected opportunity'),
        summary: input.filmingRecommendation?.localizedReason
          ?? t(language, 'Há uma boa janela na semana para avançar conteúdo sem lutar contra o resto do sistema.', 'There is a good week window to advance content without fighting the rest of the system.'),
        currentStage: t(language, 'Janela para avançar', 'Window to advance'),
        confidence: scheduleDecisionConfidence
          ?? input.filmingRecommendation?.localizedConfidenceLabel
          ?? t(language, 'Confiança média', 'Medium confidence'),
        state,
        primaryAction: {
          title: snapshot.deskReady > 0 || snapshot.directIdeas > 0 ? t(language, 'Continuar roteiro', 'Continue script') : t(language, 'Abrir radar', 'Open radar'),
          icon: snapshot.deskReady > 0 || snapshot.directIdeas > 0 ? 'wand.and.stars' : 'dot.radiowaves.left.and.right',
          target: snapshot.deskReady > 0 || snapshot.directIdeas > 0 ? 'scriptGenerator' : 'radar',
        },
        secondaryAction: { title: t(language, 'Abrir agenda', 'Open schedule'), icon: 'calendar', target: 'schedule' },
      };
    case 'backlogOverload':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Destravar o pipeline antes de abrir mais ideias', 'Unblock the pipeline before opening more ideas'),
        subtitle: t(language, 'Backlog carregado · prioridade baixa dispersa', 'Backlog heavy · priority is getting diluted'),
        summary: tPT(language, 'Há demasiadas peças abertas ao mesmo tempo. O melhor movimento agora é fechar ou mover as mais maduras para recuperar foco.', 'Há peças demais abertas ao mesmo tempo. O melhor movimento agora é fechar ou mover as mais maduras para recuperar foco.', 'There are too many open pieces at the same time. The best move now is closing or moving the most mature ones to recover focus.'),
        currentStage: t(language, 'Pipeline com pressão', 'Pipeline under pressure'),
        confidence: t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Ver pipeline', 'View pipeline'), icon: 'square.stack.3d.up.fill', target: 'pipeline' },
        secondaryAction: { title: t(language, 'Abrir tarefas', 'Open tasks'), icon: 'checklist', target: 'tasks' },
      };
    case 'learningAvailable':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: tPT(language, 'Rever o que está a funcionar antes da próxima peça', 'Rever o que está funcionando antes da próxima peça', 'Review what is working before the next piece'),
        subtitle: t(language, 'Aprendizagem nova disponível', 'New learning available'),
        summary: optimizationSummary(input, language)
          ?? t(language, 'O sistema já tem um padrão recente. Vale usá-lo agora para refinar o próximo conteúdo, em vez de começar do zero.', 'The system already has a recent pattern. It is worth using it now to refine the next piece instead of starting from scratch.'),
        currentStage: t(language, 'Aprendizagem pronta', 'Learning ready'),
        confidence: t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir aprendizagens', 'Open learnings'), icon: 'chart.line.uptrend.xyaxis', target: 'learnings' },
        secondaryAction: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
      };
    case 'lowConfidence':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: t(language, 'Validar a próxima gravação antes de a tratar como decisão', 'Validate the next filming slot before treating it as a decision'),
        subtitle: t(language, 'Recomendação com confiança baixa', 'Low-confidence recommendation'),
        summary: input.filmingRecommendation?.localizedReason
          ?? t(language, 'Há uma possibilidade na agenda, mas o sistema ainda não a lê como aposta forte.', 'There is a possible slot on the calendar, but the system does not yet read it as a strong bet.'),
        currentStage: t(language, 'Janela por confirmar', 'Window needs confirmation'),
        confidence: scheduleDecisionConfidence
          ?? input.filmingRecommendation?.localizedConfidenceLabel
          ?? t(language, 'Baixa confiança', 'Low confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir agenda', 'Open schedule'), icon: 'calendar', target: 'schedule' },
        secondaryAction: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
      };
  }
}

function buildReasoning(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  snapshot: Snapshot,
  language: Lang,
): CreativeReasoningModel | null {
  const signals: CreativeReasoningSignal[] = [];
  const schedulePlanIsProposed = (input.filmingRecommendation != null || isScheduleDecisionState(state))
    && scheduleDecisionRequiresReview(input, state);
  const workPlanStatus = resolveContentWorkPlanStatus(input);

  const desk = input.discovery?.deskItems[0];
  if (desk) {
    signals.push({
      id: 'desk',
      title: t(language, 'Radar', 'Radar'),
      effect: desk.title,
      detail: desk.body,
      tone: 'opportunity',
    });
  } else if (snapshot.activeDiscoverySignals > 0 || snapshot.monitoredPillars > 0) {
    const count = Math.max(snapshot.activeDiscoverySignals, snapshot.monitoredPillars);
    signals.push({
      id: 'discovery',
      title: t(language, 'Descoberta', 'Discovery'),
      effect: tPT(
        language,
        count === 1 ? '1 sinal já está a empurrar o próximo tema.' : `${count} sinais já estão a empurrar o próximo tema.`,
        count === 1 ? '1 sinal já está empurrando o próximo tema.' : `${count} sinais já estão empurrando o próximo tema.`,
        count === 1 ? '1 signal is already pushing the next topic.' : `${count} signals are already pushing the next topic.`,
      ),
      detail: null,
      tone: 'opportunity',
    });
  }

  if (input.filmingRecommendation) {
    signals.push({
      id: 'schedule',
      title: t(language, 'Agenda', 'Schedule'),
      effect: input.filmingRecommendation.localizedReason,
      detail: t(language, 'A recomendação é uma proposta e requer confirmação da Secretary antes de reservar tempo.', 'The recommendation is a proposal and requires Secretary confirmation before it reserves time.'),
      tone: 'caution',
    });
  }

  if (schedulePlanIsProposed) {
    const authorityStatus = input.workSchedule?.authorityStatus ?? 'unavailable';
    signals.push({
      id: 'schedule-authority',
      title: t(language, 'Autoridade da agenda', 'Schedule authority'),
      effect: authorityStatus === 'unavailable'
        ? t(language, 'A autoridade da agenda está indisponível e o estado do plano é unavailable.', 'Schedule authority is unavailable and plan status is unavailable.')
        : authorityStatus === 'partially_unavailable'
          ? t(language, 'A autoridade da agenda está parcial e o estado do plano é partial.', 'Schedule authority is partial and plan status is partial.')
          : workPlanStatus === 'confirmed' && snapshot.scheduleAttention > 0
            ? t(language, 'A autoridade da agenda está atual e o bloco privado continua confirmado, mas há um estado de sincronização ou agenda que precisa de atenção.', 'Schedule authority is current and the private block remains confirmed, but a provider-sync or schedule state needs attention.')
            : workPlanStatus === 'unplanned'
              ? t(language, 'A autoridade da agenda está atual, mas não há blocos privados confirmados: plano unplanned.', 'Schedule authority is current, but there are no confirmed private blocks: plan status unplanned.')
              : t(language, 'A autoridade da agenda está atual, mas a janela continua proposta até a Secretary confirmar um bloco privado.', 'Schedule authority is current, but the window remains proposed until Secretary confirms a private block.'),
      detail: workPlanStatus === 'confirmed' && snapshot.scheduleAttention > 0
        ? t(language, 'O bloco confirmado continua protegido; revê a atenção do provider ou da agenda separadamente.', 'The confirmed block remains protected; review provider or schedule attention separately.')
        : snapshot.scheduledWorkBlocks > 0
          ? t(language, 'Os blocos confirmados continuam visíveis, mas revê o plano global antes de o tratar como protegido.', 'Confirmed blocks remain visible, but review the overall plan before treating it as protected.')
          : t(language, 'Revê a agenda antes de tratar qualquer recomendação como protegida.', 'Review the schedule before treating any recommendation as protected.'),
      tone: 'caution',
    });
  } else if (snapshot.scheduledWorkBlocks > 0) {
    signals.push({
      id: 'work-schedule',
      title: t(language, 'Plano de trabalho', 'Work plan'),
      effect: tPT(
        language,
        snapshot.scheduledWorkBlocks === 1 ? '1 sessão privada de conteúdo está confirmada para esta semana.' : `${snapshot.scheduledWorkBlocks} sessões privadas de conteúdo estão confirmadas para esta semana.`,
        snapshot.scheduledWorkBlocks === 1 ? '1 sessão privada de conteúdo está confirmada para esta semana.' : `${snapshot.scheduledWorkBlocks} sessões privadas de conteúdo estão confirmadas para esta semana.`,
        snapshot.scheduledWorkBlocks === 1 ? '1 private content work session is confirmed for this week.' : `${snapshot.scheduledWorkBlocks} private content work sessions are confirmed for this week.`,
      ),
      detail: t(language, 'Agendar trabalho não agenda publicação.', 'Scheduling work does not schedule publication.'),
      tone: 'supportive',
    });
  } else if (!input.filmingRecommendation && snapshot.deadlineTopics > 0) {
    signals.push({
      id: 'deadline',
      title: t(language, 'Prazo do workspace', 'Workspace deadline'),
      effect: tPT(
        language,
        snapshot.deadlineTopics === 1 ? '1 peça tem prazo, mas ainda não tem um bloco privado confirmado.' : `${snapshot.deadlineTopics} peças têm prazo, mas ainda não têm blocos privados confirmados.`,
        snapshot.deadlineTopics === 1 ? '1 peça tem prazo, mas ainda não tem um bloco privado confirmado.' : `${snapshot.deadlineTopics} peças têm prazo, mas ainda não têm blocos privados confirmados.`,
        snapshot.deadlineTopics === 1 ? '1 piece has a deadline but no confirmed private work block.' : `${snapshot.deadlineTopics} pieces have deadlines but no confirmed private work blocks.`,
      ),
      detail: t(language, 'Um prazo não é um evento de calendário.', 'A deadline is not a calendar event.'),
      tone: 'caution',
    });
  }

  if (snapshot.hasVoiceDNA) {
    signals.push({
      id: 'voice',
      title: t(language, 'Voice DNA', 'Voice DNA'),
      effect: tPT(language, `A tua voz já tem ${snapshot.voicePatterns} padrões ativos para guiar o próximo roteiro.`, `Sua voz já tem ${snapshot.voicePatterns} padrões ativos para guiar o próximo roteiro.`, `Your voice already has ${snapshot.voicePatterns} active patterns guiding the next script.`),
      detail: null,
      tone: 'supportive',
    });
  }

  const optimizationSignal = input.optimization?.recentSignals[0];
  if (optimizationSignal) {
    signals.push({
      id: 'learning',
      title: t(language, 'Aprendizagem', 'Learning'),
      effect: optimizationSignal.title,
      detail: optimizationSignal.summary,
      tone: 'supportive',
    });
  } else if (snapshot.optimizationSignals > 0) {
    signals.push({
      id: 'optimization',
      title: t(language, 'Otimização', 'Optimization'),
      effect: tPT(
        language,
        snapshot.optimizationSignals === 1 ? '1 sinal já está a afinar o que repetir.' : `${snapshot.optimizationSignals} sinais já estão a afinar o que repetir.`,
        snapshot.optimizationSignals === 1 ? '1 sinal já está refinando o que repetir.' : `${snapshot.optimizationSignals} sinais já estão refinando o que repetir.`,
        snapshot.optimizationSignals === 1 ? '1 signal is already refining what to repeat.' : `${snapshot.optimizationSignals} signals are already refining what to repeat.`,
      ),
      detail: null,
      tone: 'supportive',
    });
  }

  if (state === 'backlogOverload') {
    signals.unshift({
      id: 'backlog',
      title: t(language, 'Carga do pipeline', 'Pipeline load'),
      effect: t(language, `${snapshot.totalOpenWork} itens estão abertos ao mesmo tempo.`, `${snapshot.totalOpenWork} items are open at the same time.`),
      detail: t(language, 'Fechar ou mover os mais maduros vai devolver foco ao sistema.', 'Closing or moving the most mature ones will give focus back to the system.'),
      tone: 'caution',
    });
  }

  if (signals.length === 0) return null;

  return {
    title: t(language, 'Por que agora', 'Why this now'),
    summary: reasoningSummary(state, input, language),
    confidence: confidenceLabel(state, input, language),
    signals: signals.slice(0, 4),
  };
}

function buildFlow(
  state: ContentHomeStageKind,
  snapshot: Snapshot,
  language: Lang,
): FlowStatusModel {
  const discoverStatus: ContentFlowStatus =
    state === 'noIdeaYet' || state === 'emptyPipeline' || (state === 'crossSkillOpportunity' && snapshot.deskReady === 0)
      ? 'current'
      : (snapshot.directIdeas > 0 || snapshot.pipelineIdeas > 0 || snapshot.deskReady > 0)
        ? 'complete'
        : 'pending';

  const writeStatus: ContentFlowStatus =
    state === 'scriptInProgress' || state === 'angleChosen' || (state === 'crossSkillOpportunity' && snapshot.deskReady > 0)
      ? 'current'
      : (snapshot.scripted > 0 || snapshot.filmed > 0 || snapshot.editing > 0)
        ? 'complete'
        : state === 'noIdeaYet'
          ? 'blocked'
          : 'pending';

  const scheduleStatus: ContentFlowStatus =
    state === 'readyToFilm' || state === 'lowConfidence' || state === 'scheduled'
      ? 'current'
      : snapshot.scheduledWorkBlocks > 0
        ? 'complete'
        : (snapshot.scripted === 0 && snapshot.readyTopics === 0)
          ? 'blocked'
          : 'pending';

  const learningStatus: ContentFlowStatus =
    state === 'learningAvailable'
      ? 'current'
      : snapshot.optimizationSignals > 0
        ? 'complete'
        : 'pending';

  return {
    title: t(language, 'Fluxo do conteúdo', 'Content flow'),
    steps: [
      {
        id: 'discover',
        title: t(language, 'Descobrir', 'Discover'),
        summary: snapshot.deskReady > 0
          ? t(language, `${snapshot.deskReady} na mesa`, `${snapshot.deskReady} on desk`)
          : t(language, 'Próximo tema', 'Next topic'),
        status: discoverStatus,
      },
      {
        id: 'write',
        title: t(language, 'Escrever', 'Write'),
        summary: snapshot.scripted > 0
          ? t(language, `${snapshot.scripted} em curso`, `${snapshot.scripted} in progress`)
          : t(language, 'Roteiro', 'Script'),
        status: writeStatus,
      },
      {
        id: 'schedule',
        title: t(language, 'Agendar', 'Schedule'),
        summary: snapshot.scheduledWorkBlocks > 0
          ? t(language, `${snapshot.scheduledWorkBlocks} blocos`, `${snapshot.scheduledWorkBlocks} work blocks`)
          : t(language, 'Janela', 'Window'),
        status: scheduleStatus,
      },
      {
        id: 'learn',
        title: t(language, 'Aprender', 'Learn'),
        summary: snapshot.optimizationSignals > 0
          ? t(language, `${snapshot.optimizationSignals} sinais`, `${snapshot.optimizationSignals} insights`)
          : t(language, 'Loop semanal', 'Weekly loop'),
        status: learningStatus,
      },
    ],
  };
}

function buildActions(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  snapshot: Snapshot,
  language: Lang,
): PrioritizedActionModel[] {
  const candidateTitle = preferredIdeaTitle(input, language);

  switch (state) {
    case 'noIdeaYet':
      return [
        {
          id: 'radar',
          title: t(language, 'Abrir radar', 'Open radar'),
          summary: t(language, 'Puxa sinais novos para dar ao sistema um tema com força suficiente.', 'Pull fresh signals so the system has a strong enough topic.'),
          impact: t(language, 'Desbloqueia o resto do fluxo', 'Unlocks the rest of the flow'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'radar',
          tint: 'info',
        },
        {
          id: 'note',
          title: t(language, 'Capturar nota bruta', 'Capture raw note'),
          summary: t(language, 'Guarda uma ideia ou observação antes que ela desapareça.', 'Save an idea or observation before it disappears.'),
          impact: t(language, 'Cria matéria-prima para o radar', 'Creates raw material for radar'),
          estimatedEffort: t(language, '2 min', '2 min'),
          target: 'captureNote',
          tint: 'content',
        },
      ];
    case 'angleChosen':
    case 'scriptInProgress':
    case 'crossSkillOpportunity':
      return [
        {
          id: 'script',
          title: t(language, 'Continuar roteiro', 'Continue script'),
          summary: t(language, `Transforma “${candidateTitle}” numa peça pronta a avançar.`, `Turn “${candidateTitle}” into a piece ready to move.`),
          impact: t(language, 'Move o fluxo para gravação', 'Moves the flow toward filming'),
          estimatedEffort: t(language, '15–20 min', '15–20 min'),
          target: 'scriptGenerator',
          tint: 'content',
        },
        {
          id: 'pipeline',
          title: t(language, 'Ver pipeline', 'View pipeline'),
          summary: t(language, 'Confirma o que já está em curso antes de abrir mais frentes.', 'Confirm what is already in motion before opening more fronts.'),
          impact: t(language, 'Reduz dispersão', 'Reduces dispersion'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'pipeline',
          tint: 'accent',
        },
        {
          id: 'voice',
          title: t(language, 'Abrir Voice DNA', 'Open Voice DNA'),
          summary: tPT(language, 'Usa o que já está na tua voz para o roteiro sair mais alinhado logo à primeira.', 'Usa o que já está na sua voz para o roteiro sair mais alinhado logo de primeira.', 'Use what is already in your voice so the script lands more aligned on the first pass.'),
          impact: t(language, 'Melhora qualidade do texto', 'Improves script quality'),
          estimatedEffort: t(language, '4 min', '4 min'),
          target: 'voiceDNA',
          tint: 'info',
        },
      ];
    case 'readyToFilm':
    case 'lowConfidence':
      return [
        {
          id: 'schedule',
          title: t(language, 'Pedir janela de gravação', 'Request filming window'),
          summary: input.filmingRecommendation
            ? t(
                language,
                `${input.filmingRecommendation.localizedReason} Continua a ser uma proposta até a Secretary confirmar o bloco privado.`,
                `${input.filmingRecommendation.localizedReason} This remains a proposal until Secretary confirms the private block.`,
              )
            : t(language, 'Pede à Secretary uma pré-visualização da janela mais limpa; ainda não existe reserva.', 'Ask Secretary to preview the cleanest window; no reservation exists yet.'),
          impact: t(language, 'Inicia a confirmação sem assumir uma reserva', 'Starts confirmation without assuming a reservation'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'schedule',
          tint: 'accent',
        },
        {
          id: 'pipeline',
          title: t(language, 'Rever pipeline', 'Review pipeline'),
          summary: t(language, 'Confirma se a próxima peça está mesmo pronta para sair do texto.', 'Confirm the next piece is really ready to leave the writing stage.'),
          impact: t(language, 'Evita bloquear gravação com trabalho incompleto', 'Avoids blocking filming with incomplete work'),
          estimatedEffort: t(language, '4 min', '4 min'),
          target: 'pipeline',
          tint: 'content',
        },
        {
          id: 'tasks',
          title: t(language, 'Atacar tarefas de conteúdo', 'Attack content tasks'),
          summary: t(language, 'Fecha o que ainda está pendente antes de filmar ou entregar a peça.', 'Close what is still pending before filming or handing off the piece.'),
          impact: t(language, 'Diminui atrito operacional', 'Reduces operational friction'),
          estimatedEffort: t(language, '5 min', '5 min'),
          target: 'tasks',
          tint: 'warning',
        },
      ];
    case 'scheduled':
      return [
        {
          id: 'schedule',
          title: t(language, 'Rever bloco de trabalho', 'Review work block'),
          summary: t(language, 'Confirma objetivo, duração e dependências da sessão privada já agendada.', 'Confirm the objective, duration, and dependencies of the scheduled private session.'),
          impact: t(language, 'Protege a execução sem confundir trabalho com publicação', 'Protects execution without confusing work with publication'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'schedule',
          tint: 'accent',
        },
        {
          id: 'pipeline',
          title: t(language, 'Rever pipeline', 'Review pipeline'),
          summary: t(language, 'Liga o bloco ao item e à próxima ação corretos.', 'Connect the block to the correct item and next action.'),
          impact: t(language, 'Evita trabalho sem contexto', 'Avoids context-free work'),
          estimatedEffort: t(language, '4 min', '4 min'),
          target: 'pipeline',
          tint: 'content',
        },
        {
          id: 'tasks',
          title: t(language, 'Resolver bloqueios', 'Resolve blockers'),
          summary: t(language, 'Fecha dependências antes do início da sessão.', 'Close dependencies before the session starts.'),
          impact: t(language, 'Aumenta a probabilidade de concluir o bloco', 'Improves the odds of completing the block'),
          estimatedEffort: t(language, '5 min', '5 min'),
          target: 'tasks',
          tint: 'warning',
        },
      ];
    case 'emptyPipeline':
      return [
        {
          id: 'radar-reopen',
          title: t(language, 'Abrir radar', 'Open radar'),
          summary: t(language, 'Repõe movimento no sistema com um tema novo ou um sinal fresco.', 'Restore movement in the system with a fresh topic or signal.'),
          impact: t(language, 'Reabre o pipeline com intenção', 'Reopens the pipeline with intent'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'radar',
          tint: 'info',
        },
        {
          id: 'learn-reuse',
          title: t(language, 'Rever aprendizagens', 'Review learnings'),
          summary: t(language, 'Usa o que já funcionou para escolher melhor a próxima peça.', 'Use what already worked to choose the next piece better.'),
          impact: t(language, 'Aumenta a qualidade do próximo arranque', 'Improves the quality of the next start'),
          estimatedEffort: t(language, '4 min', '4 min'),
          target: 'learnings',
          tint: 'success',
        },
      ];
    case 'backlogOverload':
      return [
        {
          id: 'pipeline',
          title: t(language, 'Limpar pipeline', 'Clean the pipeline'),
          summary: t(language, 'Escolhe as peças maduras e move-as. O resto pode esperar.', 'Choose the mature pieces and move them. The rest can wait.'),
          impact: t(language, 'Recupera foco criativo', 'Recovers creative focus'),
          estimatedEffort: t(language, '8 min', '8 min'),
          target: 'pipeline',
          tint: 'warning',
        },
        {
          id: 'tasks',
          title: t(language, 'Abrir tarefas', 'Open tasks'),
          summary: t(language, 'Usa a caixa de entrada para saber o que ainda bloqueia cada peça.', 'Use the inbox to see what is still blocking each piece.'),
          impact: t(language, 'Torna a execução mais clara', 'Makes execution clearer'),
          estimatedEffort: t(language, '5 min', '5 min'),
          target: 'tasks',
          tint: 'accent',
        },
      ];
    case 'learningAvailable':
      return [
        {
          id: 'learn',
          title: t(language, 'Abrir aprendizagens', 'Open learnings'),
          summary: t(language, 'Revê o padrão mais recente antes de escrever ou gravar a próxima peça.', 'Review the latest pattern before writing or filming the next piece.'),
          impact: t(language, 'Aumenta a probabilidade de repetir o que funcionou', 'Increases the odds of repeating what worked'),
          estimatedEffort: t(language, '4 min', '4 min'),
          target: 'learnings',
          tint: 'success',
        },
        {
          id: 'radar',
          title: t(language, 'Abrir radar', 'Open radar'),
          summary: t(language, 'Leva a aprendizagem nova para a próxima seleção de temas.', 'Carry the new learning into the next topic selection.'),
          impact: t(language, 'Liga aprendizagem à próxima execução', 'Connects learning to the next execution'),
          estimatedEffort: t(language, '3 min', '3 min'),
          target: 'radar',
          tint: 'info',
        },
      ];
  }
}

function buildPipelineHealth(
  state: ContentHomeStageKind,
  snapshot: Snapshot,
  language: Lang,
): PipelineHealthModel {
  const attentionCount = Math.max(
    snapshot.scheduleAttention,
    Math.max(0, snapshot.totalOpenWork - Math.max(1, snapshot.scheduledWorkBlocks)),
  );

  let summary: string;
  switch (state) {
    case 'backlogOverload':
      summary = t(language, 'Há muito trabalho aberto ao mesmo tempo. O sistema ganha mais quando fechas movimento, não quando acrescentas ferramentas.', 'There is too much open work at the same time. The system wins more when you close motion, not when you add tools.');
      break;
    case 'scheduled':
      summary = tPT(language, 'Já existe massa crítica suficiente para filmar ou agendar. O foco agora é proteger execução.', 'Já existe massa crítica suficiente para filmar ou agendar. O foco agora é proteger a execução.', 'There is enough momentum to film or schedule. The focus now is protecting execution.');
      break;
    case 'readyToFilm':
    case 'lowConfidence':
      summary = tPT(language, 'Já existe massa crítica suficiente para propor uma sessão. O foco agora é pedir confirmação à Secretary, não assumir uma reserva.', 'Já existe massa crítica suficiente para propor uma sessão. O foco agora é pedir confirmação ao Secretário, não assumir uma reserva.', 'There is enough momentum to propose a session. The focus now is asking Secretary to confirm it, not assuming a reservation.');
      break;
    case 'learningAvailable':
      summary = tPT(language, 'O sistema já está a ensinar o que repetir. Usa esse sinal para refinar o próximo conteúdo.', 'O sistema já está ensinando o que repetir. Use esse sinal para refinar o próximo conteúdo.', 'The system is already teaching what to repeat. Use that signal to refine the next piece.');
      break;
    case 'emptyPipeline':
      summary = tPT(language, 'Há contexto acumulado, mas não há nenhuma peça viva agora. O melhor ganho é repor movimento com clareza.', 'Há contexto acumulado, mas não há nenhuma peça viva agora. O melhor ganho é repor movimento com clareza.', 'There is accumulated context, but no live piece right now. The best gain is restoring movement clearly.');
      break;
    default:
      summary = t(language, 'Vê rapidamente o que está pronto, o que ainda está em curso e onde existe atrito no pipeline.', 'See quickly what is ready, what is still in progress, and where friction exists in the pipeline.');
      break;
  }

  return {
    title: t(language, 'Saúde do pipeline', 'Pipeline health'),
    summary,
    publicationTracking: {
      availability: 'unavailable',
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
      publicationExecution: 'not_supported',
    },
    metrics: [
      { id: 'ideas', label: t(language, 'Ideias', 'Ideas'), value: String(Math.max(snapshot.pipelineIdeas, snapshot.directIdeas, snapshot.deskReady)), tint: 'info' },
      { id: 'scripts', label: t(language, 'Roteiros', 'Scripts'), value: String(Math.max(snapshot.scripted, snapshot.draftingTopics)), tint: 'content' },
      { id: 'ready', label: t(language, 'Prontos', 'Ready'), value: String(snapshot.readyTopics + snapshot.filmed), tint: 'accent' },
      { id: 'scheduled', label: t(language, 'Blocos de trabalho', 'Work blocks'), value: String(snapshot.scheduledWorkBlocks), tint: 'success' },
      { id: 'published', label: t(language, 'Publicação externa', 'External publishing'), value: t(language, 'Não monitorizada', 'Not tracked'), tint: 'info' },
      { id: 'attention', label: t(language, 'Atenção', 'Needs attention'), value: String(attentionCount), tint: 'warning' },
    ],
  };
}

function buildEmptyState(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  snapshot: Snapshot,
  language: Lang,
): ContentEmptyStateModel | null {
  if (!snapshot.hasAnyData && input.hasAttemptedLoad && input.lastLoadError) {
    return {
      title: tPT(language, 'Ainda estamos a reunir o teu sistema criativo', 'Ainda estamos reunindo o seu sistema criativo', 'We are still gathering your creative system'),
      detail: t(language, 'Sem radar, pipeline ou sinais ativos, o melhor primeiro passo é abrir o radar para começar a dar contexto ao resto do sistema.', 'Without radar, pipeline, or active signals, the best first step is opening radar to start giving context to the rest of the system.'),
      action: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
    };
  }

  if (state === 'emptyPipeline') {
    return {
      title: tPT(language, 'O pipeline está vazio, não parado', 'O pipeline está vazio, não parado', 'The pipeline is empty, not dead'),
      detail: tPT(language, 'Já existe contexto, voz e aprendizagem no sistema. O que falta agora é voltar a pôr uma peça em movimento.', 'Já existe contexto, voz e aprendizagem no sistema. O que falta agora é voltar a pôr uma peça em movimento.', 'There is already context, voice, and learning in the system. What is missing now is putting a piece back in motion.'),
      action: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
    };
  }

  if (state !== 'noIdeaYet') return null;

  return {
    title: tPT(language, 'Ainda não tens a próxima peça em movimento', 'Você ainda não tem a próxima peça em movimento', 'You do not have the next piece in motion yet'),
    detail: tPT(language, 'Quando o radar ainda não puxou um tema forte, o sistema parece vazio. O que desbloqueia tudo é dar-lhe um primeiro sinal ou uma nota bruta.', 'Quando o radar ainda não puxou um tema forte, o sistema parece vazio. O que desbloqueia tudo é dar ao sistema um primeiro sinal ou uma nota bruta.', 'When radar has not pulled a strong topic yet, the system can feel empty. What unlocks everything is giving it a first signal or raw note.'),
    action: { title: t(language, 'Abrir radar', 'Open radar'), icon: 'dot.radiowaves.left.and.right', target: 'radar' },
  };
}

function preferredIdeaTitle(input: ContentHomeBuildInput, language: Lang): string {
  const deskTitle = input.discovery?.deskItems[0]?.title;
  if (deskTitle && deskTitle.trim().length > 0) return deskTitle;
  const firstIdea = input.ideas[0]?.title;
  if (firstIdea && firstIdea.trim().length > 0) return firstIdea;
  const firstPipelineIdea = input.pipeline?.stages.ideas[0]?.title;
  if (firstPipelineIdea && firstPipelineIdea.trim().length > 0) return firstPipelineIdea;
  const firstPillar = input.discovery?.monitoredPillars[0]?.name;
  if (firstPillar && firstPillar.trim().length > 0) return firstPillar;
  return t(language, 'o próximo tema', 'the next topic');
}

function confidenceLabel(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  language: Lang,
): string {
  if (scheduleDecisionRequiresReview(input, state) && isScheduleDecisionState(state)) {
    return t(language, 'Revisão necessária', 'Review required');
  }

  switch (state) {
    case 'scheduled':
      return t(language, 'Alta confiança', 'High confidence');
    case 'emptyPipeline':
      return t(language, 'Confiança média', 'Medium confidence');
    case 'crossSkillOpportunity':
      return input.filmingRecommendation?.localizedConfidenceLabel ?? t(language, 'Confiança média', 'Medium confidence');
    case 'readyToFilm':
    case 'lowConfidence':
      return input.filmingRecommendation?.localizedConfidenceLabel ?? t(language, 'Confiança média', 'Medium confidence');
    case 'scriptInProgress':
    case 'backlogOverload':
    case 'learningAvailable':
      return t(language, 'Alta confiança', 'High confidence');
    default:
      return t(language, 'Confiança média', 'Medium confidence');
  }
}

function reasoningSummary(
  state: ContentHomeStageKind,
  input: ContentHomeBuildInput,
  language: Lang,
): string {
  if (scheduleDecisionRequiresReview(input, state) && isScheduleDecisionState(state)) {
    const planStatus = resolveContentWorkPlanStatus(input);
    return t(
      language,
      `O sinal de conteúdo pode continuar válido, mas o estado do plano é ${planStatus}. Só blocos privados confirmados pela Secretary estão protegidos.`,
      `The content signal may remain valid, but plan status is ${planStatus}. Only private work blocks confirmed by Secretary are protected.`,
    );
  }

  switch (state) {
    case 'noIdeaYet':
      return t(language, 'O sistema ainda precisa de um sinal forte antes de abrir o fluxo inteiro.', 'The system still needs a strong signal before opening the full flow.');
    case 'angleChosen':
      return t(language, 'Já existe contexto suficiente para escolher a direção certa sem abrir logo o roteiro.', 'There is already enough context to choose the right direction without opening the script immediately.');
    case 'scriptInProgress':
      return t(language, 'A oportunidade já está identificada. O maior ganho agora vem de transformar sinal em texto.', 'The opportunity is already identified. The biggest gain now comes from turning signal into text.');
    case 'crossSkillOpportunity':
      return t(language, 'Há uma janela boa no sistema, mas ainda precisamos transformá-la numa peça concreta.', 'There is a good window in the system, but we still need to turn it into a concrete piece.');
    case 'readyToFilm':
      return t(language, 'O sistema já juntou tema, maturidade e uma janela proposta. A próxima decisão é pedir confirmação da Secretary.', 'The system has combined topic, maturity, and a proposed window. The next decision is asking Secretary to confirm it.');
    case 'scheduled':
      return t(language, 'Já existe um bloco privado confirmado. A prioridade é chegar à sessão com objetivo e dependências claros.', 'A private work block is confirmed. The priority is reaching the session with a clear objective and dependencies.');
    case 'emptyPipeline':
      return t(language, 'O sistema tem memória e aprendizagem, mas não tem nenhuma peça viva agora.', 'The system has memory and learning, but it has no live piece right now.');
    case 'backlogOverload':
      return t(language, 'A prioridade não é criar mais; é devolver foco ao que já entrou em movimento.', 'The priority is not creating more; it is giving focus back to what is already in motion.');
    case 'learningAvailable':
      return t(language, 'Há aprendizagem suficiente para refinar o próximo conteúdo com mais precisão.', 'There is enough learning to refine the next content move with more precision.');
    case 'lowConfidence':
      return t(language, 'Existe oportunidade, mas o sistema ainda não a lê como decisão forte sem validação adicional.', 'There is opportunity, but the system does not yet read it as a strong decision without further validation.');
  }
}

function scheduleDecisionRequiresReview(
  input: ContentHomeBuildInput,
  state: ContentHomeStageKind,
): boolean {
  // A filming date is always a recommendation until Secretary confirms that
  // exact private work block. An unrelated confirmed block must never promote
  // the recommendation into calendar truth.
  if (state !== 'scheduled' && input.filmingRecommendation != null) return true;
  if ((input.workSchedule?.attentionThisWeek ?? 0) > 0) return true;
  return resolveContentWorkPlanStatus(input) !== 'confirmed';
}

function isScheduleDecisionState(state: ContentHomeStageKind): boolean {
  return state === 'readyToFilm'
    || state === 'scheduled'
    || state === 'crossSkillOpportunity'
    || state === 'lowConfidence';
}

function optimizationSummary(input: ContentHomeBuildInput, language: Lang): string | null {
  const firstSignal = input.optimization?.recentSignals[0];
  if (firstSignal?.summary) return firstSignal.summary;
  if ((input.optimization?.activeInsightCount ?? 0) > 0) {
    return tPT(language, `${input.optimization!.activeInsightCount} aprendizagens já estão a afinar o próximo conteúdo.`, `${input.optimization!.activeInsightCount} aprendizagens já estão refinando o próximo conteúdo.`, `${input.optimization!.activeInsightCount} learnings are already refining the next content move.`);
  }
  return null;
}

function isTerminalTopic(status: ContentHomeTopicDigest['status']): boolean {
  return status === 'published' || status === 'cancelled';
}

function shortDate(value: string, language: Lang): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  const locale = language === 'pt-BR' ? 'pt-BR' : language.startsWith('pt') ? 'pt-PT' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function t(language: Lang, portuguese: string, english: string): string {
  return language.startsWith('pt') ? portuguese : english;
}

function tPT(language: Lang, portugal: string, brazil: string, english: string): string {
  if (language === 'pt-BR') return brazil;
  if (language === 'pt-PT') return portugal;
  return english;
}
