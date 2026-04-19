// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ScreenContractMeta } from './screen-contract-meta';
import { buildScreenContractMeta } from './screen-contract-meta';
import type { Lang } from '../utils/i18n';

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
}

export interface ContentEmptyStateModel {
  title: string;
  detail: string;
  action: ContentHeroActionModel;
}

export interface ContentHomeViewState {
  meta: ScreenContractMeta;
  hero: NextBestActionHeroModel;
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

export interface ContentHomePipelineInput {
  stages: {
    ideas: ContentHomeIdeaDigest[];
    scripted: ContentHomeIdeaDigest[];
    filmed: ContentHomeIdeaDigest[];
    editing: ContentHomeIdeaDigest[];
    published: ContentHomeIdeaDigest[];
  };
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
  published: number;
  directIdeas: number;
  scheduledTopics: number;
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
    meta: input.meta ?? inferContentContractMeta(input),
    hero: buildHero(state, input, snapshot, language),
    reasoning: buildReasoning(state, input, snapshot, language),
    flow: buildFlow(state, snapshot, language),
    actions: buildActions(state, input, snapshot, language),
    pipelineHealth: buildPipelineHealth(state, snapshot, language),
    emptyState: buildEmptyState(state, input, snapshot, language),
  };
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
  const published = input.pipeline?.stages.published.length ?? 0;

  const scheduledTopics = input.topics.filter((topic) => !isTerminalTopic(topic.status) && topic.scheduledDate != null).length;
  const readyTopics = input.topics.filter((topic) => topic.status === 'ready').length;
  const draftingTopics = input.topics.filter((topic) => topic.status === 'drafting').length;

  const deskReady = input.discovery?.deskReadyCount ?? 0;
  const monitoredPillars = input.discovery?.monitoredPillars.length ?? 0;
  const optimizationSignals = input.optimization?.recentSignals.length ?? input.optimization?.activeInsightCount ?? 0;
  const voicePatterns = input.script?.voicePatternCount ?? 0;
  const hasVoiceDNA = input.script?.hasBrandVoice ?? false;
  const activeDiscoverySignals = input.discovery?.activeCount ?? 0;

  const totalOpenWork = pipelineIdeas + scripted + filmed + editing + draftingTopics + readyTopics + scheduledTopics;
  const hasAnyData =
    pipelineIdeas + scripted + filmed + editing + published + input.ideas.length + input.topics.length + deskReady + monitoredPillars + optimizationSignals > 0;

  return {
    pipelineIdeas,
    scripted,
    filmed,
    editing,
    published,
    directIdeas: input.ideas.length,
    scheduledTopics,
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
  const hasMatureExecutionStep = snapshot.scripted > 0 || snapshot.readyTopics > 0 || snapshot.filmed > 0 || snapshot.scheduledTopics > 0;

  if (snapshot.totalOpenWork >= 7 && (snapshot.scripted + snapshot.editing + snapshot.readyTopics) > 1) {
    return 'backlogOverload';
  }

  if (snapshot.scheduledTopics > 0 && snapshot.scripted === 0 && snapshot.readyTopics === 0 && snapshot.filmed === 0 && snapshot.editing === 0 && snapshot.draftingTopics === 0) {
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

  if (snapshot.optimizationSignals > 0 && snapshot.published > 0) {
    return 'learningAvailable';
  }

  if (snapshot.hasAnyData && snapshot.totalOpenWork === 0 && snapshot.published > 0) {
    return 'emptyPipeline';
  }

  if (snapshot.directIdeas > 0 || snapshot.pipelineIdeas > 0 || snapshot.deskReady > 0) {
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
          ?? t(language, 'O sistema já vê maturidade suficiente para sair do texto e proteger a execução no calendário.', 'The system already sees enough maturity to move from text into protected execution on the calendar.'),
        currentStage: t(language, 'Pronto para filmar', 'Ready to film'),
        confidence: input.filmingRecommendation?.localizedConfidenceLabel ?? t(language, 'Alta confiança', 'High confidence'),
        state,
        primaryAction: { title: t(language, 'Abrir agenda', 'Open schedule'), icon: 'calendar', target: 'schedule' },
        secondaryAction: { title: t(language, 'Ver pipeline', 'View pipeline'), icon: 'square.stack.3d.up.fill', target: 'pipeline' },
      };
    case 'scheduled':
      return {
        eyebrow: t(language, 'PRÓXIMA JOGADA', 'NEXT MOVE'),
        title: tPT(language, 'Proteger a publicação já alinhada', 'Proteger a publicação já alinhada', 'Protect the scheduled publish move'),
        subtitle: t(language, 'Peça já agendada', 'Piece already scheduled'),
        summary: tPT(language, 'A próxima peça já tem lugar no calendário. O melhor uso deste momento é garantir que publicação, tarefas e contexto continuam alinhados.', 'A próxima peça já tem lugar no calendário. O melhor uso deste momento é garantir que publicação, tarefas e contexto continuem alinhados.', 'The next piece already has a place on the calendar. The best use of this moment is making sure publishing, tasks, and context stay aligned.'),
        currentStage: t(language, 'Agendado', 'Scheduled'),
        confidence: t(language, 'Alta confiança', 'High confidence'),
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
        confidence: input.filmingRecommendation?.localizedConfidenceLabel ?? t(language, 'Confiança média', 'Medium confidence'),
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
        confidence: input.filmingRecommendation?.localizedConfidenceLabel ?? t(language, 'Baixa confiança', 'Low confidence'),
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
      effect: tPT(language, `${count} sinais já estão a empurrar o próximo tema.`, `${count} sinais já estão empurrando o próximo tema.`, `${count} signals are already pushing the next topic.`),
      detail: null,
      tone: 'opportunity',
    });
  }

  if (input.filmingRecommendation) {
    signals.push({
      id: 'schedule',
      title: t(language, 'Agenda', 'Schedule'),
      effect: input.filmingRecommendation.localizedReason,
      detail: input.filmingRecommendation.localizedConfidenceLabel,
      tone: input.filmingRecommendation.confidence === 'low' ? 'caution' : 'supportive',
    });
  } else if (snapshot.scheduledTopics > 0) {
    signals.push({
      id: 'calendar',
      title: t(language, 'Calendário', 'Calendar'),
      effect: t(language, `${snapshot.scheduledTopics} peça${snapshot.scheduledTopics === 1 ? '' : 's'} já estão protegidas no calendário.`, `${snapshot.scheduledTopics} piece${snapshot.scheduledTopics === 1 ? '' : 's'} are already protected on the calendar.`),
      detail: null,
      tone: 'supportive',
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
      effect: tPT(language, `${snapshot.optimizationSignals} sinais já estão a afinar o que repetir.`, `${snapshot.optimizationSignals} sinais já estão refinando o que repetir.`, `${snapshot.optimizationSignals} signals are already refining what to repeat.`),
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
    summary: reasoningSummary(state, language),
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
      : (snapshot.scripted > 0 || snapshot.filmed > 0 || snapshot.editing > 0 || snapshot.published > 0)
        ? 'complete'
        : state === 'noIdeaYet'
          ? 'blocked'
          : 'pending';

  const scheduleStatus: ContentFlowStatus =
    state === 'readyToFilm' || state === 'lowConfidence' || state === 'scheduled'
      ? 'current'
      : (snapshot.scheduledTopics > 0 || snapshot.published > 0)
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
        summary: snapshot.scheduledTopics > 0
          ? t(language, `${snapshot.scheduledTopics} protegidos`, `${snapshot.scheduledTopics} protected`)
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
    case 'scheduled':
      return [
        {
          id: 'schedule',
          title: t(language, 'Reservar janela de gravação', 'Reserve filming window'),
          summary: input.filmingRecommendation?.localizedReason ?? t(language, 'Protege agora a janela mais limpa do calendário.', 'Protect the cleanest calendar window now.'),
          impact: t(language, 'Transforma intenção em execução', 'Turns intention into execution'),
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
          summary: t(language, 'Fecha o que ainda está pendente antes de publicar ou filmar.', 'Close what is still pending before publishing or filming.'),
          impact: t(language, 'Diminui atrito operacional', 'Reduces operational friction'),
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
  const attentionCount = Math.max(0, snapshot.totalOpenWork - Math.max(1, snapshot.scheduledTopics + snapshot.published));

  let summary: string;
  switch (state) {
    case 'backlogOverload':
      summary = t(language, 'Há muito trabalho aberto ao mesmo tempo. O sistema ganha mais quando fechas movimento, não quando acrescentas ferramentas.', 'There is too much open work at the same time. The system wins more when you close motion, not when you add tools.');
      break;
    case 'readyToFilm':
    case 'lowConfidence':
    case 'scheduled':
      summary = tPT(language, 'Já existe massa crítica suficiente para filmar ou agendar. O foco agora é proteger execução.', 'Já existe massa crítica suficiente para filmar ou agendar. O foco agora é proteger a execução.', 'There is enough momentum to film or schedule. The focus now is protecting execution.');
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
    metrics: [
      { id: 'ideas', label: t(language, 'Ideias', 'Ideas'), value: String(Math.max(snapshot.pipelineIdeas, snapshot.directIdeas, snapshot.deskReady)), tint: 'info' },
      { id: 'scripts', label: t(language, 'Roteiros', 'Scripts'), value: String(Math.max(snapshot.scripted, snapshot.draftingTopics)), tint: 'content' },
      { id: 'ready', label: t(language, 'Prontos', 'Ready'), value: String(snapshot.readyTopics + snapshot.filmed), tint: 'accent' },
      { id: 'scheduled', label: t(language, 'Agendados', 'Scheduled'), value: String(snapshot.scheduledTopics), tint: 'success' },
      { id: 'published', label: t(language, 'Publicados', 'Published'), value: String(snapshot.published), tint: 'success' },
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

function reasoningSummary(state: ContentHomeStageKind, language: Lang): string {
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
      return t(language, 'O sistema já juntou tema, maturidade e janela. Agora a decisão é proteger execução.', 'The system has already combined topic, maturity, and window. The decision now is protecting execution.');
    case 'scheduled':
      return t(language, 'A próxima peça já está protegida. A prioridade agora é manter a execução limpa até à publicação.', 'The next piece is already protected. The priority now is keeping execution clean until publish.');
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
