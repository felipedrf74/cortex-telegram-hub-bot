// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getUnreadNotifications } from './content-notification-store';
import { getDb } from './database';
import type { Lang } from '../utils/i18n';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import {
  contentScopeOrderExpr,
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import {
  CONTENT_DERIVED_CACHE_SIGNAL_TYPES,
  readRankedSignals,
} from './intelligence-bus';
import {
  filterActiveContentAgentSignals,
  PAUSED_CONTENT_AGENT_IDS,
} from './content-agent-lifecycle';
import {
  getFilmingRecommendation,
  getTopics,
  type ContentFilmingRecommendation,
  type ContentTopic,
} from './content-scheduler';

export interface ContentPillarSummary {
  name: string;
  keywordCount: number;
}

export interface ContentDeskItem {
  id: number;
  type: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface ContentSignalDigest {
  type: string;
  title: string;
  summary: string;
  priority: 'urgent' | 'normal' | 'background';
  relevanceScore: number;
  confidence: number;
}

export type ContentExecutionMode =
  | 'publish_ready'
  | 'script_ready'
  | 'reaction_window'
  | 'film_window'
  | 'discovery';

export type ContentExecutionDateSemantics =
  | 'private_deadline'
  | 'recommended_work_date'
  | 'none';

export interface ContentExecutionHint {
  mode: ContentExecutionMode;
  title: string;
  summary: string;
  /**
   * Compatibility date field. Consumers must use `dateSemantics` before
   * presenting it: topic dates are private deadlines and filming dates are
   * recommendations. Neither proves a calendar reservation or publish slot.
   */
  scheduledDate: string | null;
  dateSemantics: ContentExecutionDateSemantics;
  calendarConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  sourceType: string;
}

function reportInvalidContentIntelligenceScope(
  operation: string,
  userId: number,
  details?: Record<string, unknown>,
): void {
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId,
    details,
  });
}

export function getActiveContentPillars(
  userId: number,
  tenantId: number = userId,
): ContentPillarSummary[] {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidContentIntelligenceScope('get_active_content_pillars', userId, { tenantId });
    return [];
  }

  // Closed-beta-auth-hardening (2026-05-04): strict per-user read.
    // The previous query was `user_id IN (0, ?)` which returned both
    // the user's rows AND any `user_id=0` "platform seed" rows. The
    // post-filter at lines 84-89 (pre-fix) tried to limit the leak,
    // but `Number(row.weight ?? 0) > 1` allowed any platform-seed
    // pillar with `weight > 1` to pass through to every authenticated
    // user. The `migrations/056_content_user_isolation.sql:18` schema
    // sets `user_id INTEGER NOT NULL DEFAULT 0`, so any code that
    // wrote a config_pillars row without an explicit `user_id` ended
    // up at the platform-seed bucket — and from there leaked into
    // every authenticated user's pillar list.
    //
    // Post-fix: strict `user_id = ?`. Users with no saved pillars
    // get an empty list; the iOS Content surface then prompts them
    // to configure their pillars (the correct first-touch UX). The
    // closed-beta-hardening pass already neutralized the
    // founder-shaped pillar enum in `prompts/topic-generation.md`,
    // `content-workflow.ts`, `scorer.py`, and `orchestrator.py`, so
    // first-touch users are no longer pushed into a founder pillar
    // set even on the AI-driven path.
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const rows = db.prepare(`
      SELECT name, keywords, weight, user_id
      FROM config_pillars
      WHERE enabled = 1
        AND ${contentPrivateScopePredicate()}
      ORDER BY ${contentScopeOrderExpr(undefined, userId)}, weight DESC, name ASC
    `).all(...contentPrivateScopeParams(userId, tenantId)) as Array<{
      name: string;
      keywords: string | null;
      user_id: number;
      weight: number;
    }>;

  const deduped = new Map<string, ContentPillarSummary>();
  for (const row of rows) {
    if (!deduped.has(row.name)) {
      deduped.set(row.name, {
        name: row.name,
        keywordCount: safeJsonArray(row.keywords).length,
      });
    }
  }
  return Array.from(deduped.values());
}

export function getContentDeskItems(
  userId: number,
  limit: number,
  tenantId: number = userId,
): ContentDeskItem[] {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidContentIntelligenceScope('get_content_desk_items', userId, { limit, tenantId });
    return [];
  }

  return getUnreadNotifications(userId, limit * 3, tenantId)
    .filter((notification) => (
      notification.type === 'topic_candidates_ready'
      || notification.type === 'script_ready'
      || notification.type === 'weekly_package_ready'
    ))
    .slice(0, limit)
    .map((notification) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      createdAt: notification.createdAt,
    }));
}

export function getRankedContentSignals(
  userId: number,
  limit = 6,
  tenantId?: number,
): ContentSignalDigest[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidContentIntelligenceScope('get_ranked_content_signals', userId, { limit });
    return [];
  }

  const rankedSignals = readRankedSignals(
    'content-intelligence',
    [...CONTENT_DERIVED_CACHE_SIGNAL_TYPES],
    {
      userId,
      tenantId,
      limit,
      minConfidence: 0.2,
      excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS,
      strict: true,
    },
  );
  return filterActiveContentAgentSignals(rankedSignals).map((signal) => ({
    type: signal.signal_type,
    title: describeContentSignalTitle(signal),
    summary: describeContentSignalSummary(signal),
    priority: signal.priority,
    relevanceScore: signal.relevanceScore,
    confidence: signal.confidence,
  }));
}

export async function getNextContentExecutionHint(
  userId: number,
  opts?: {
    tenantId?: number;
    topics?: ContentTopic[];
    deskItems?: ContentDeskItem[];
    rankedSignals?: ContentSignalDigest[];
    filmingRecommendation?: ContentFilmingRecommendation | null;
    pillars?: ContentPillarSummary[];
  },
): Promise<ContentExecutionHint | null> {
  if (!isValidTenantUserId(userId)) {
    reportInvalidContentIntelligenceScope('get_next_content_execution_hint', userId);
    return null;
  }

  const topics = opts?.topics ?? getTopics(userId, {
    includeTerminal: false,
    limit: 100,
    tenantId: opts?.tenantId,
  });
  const deskItems = opts?.deskItems ?? getContentDeskItems(userId, 4, opts?.tenantId ?? userId);
  const rankedSignals = opts?.rankedSignals ?? getRankedContentSignals(userId, 4, opts?.tenantId);
  const filmingRecommendation = opts?.filmingRecommendation ?? await getFilmingRecommendation(userId, topics, opts?.tenantId);
  const pillars = opts?.pillars ?? getActiveContentPillars(userId, opts?.tenantId ?? userId);

  const readyScheduled = topics.find((topic) => topic.status === 'ready' && topic.scheduled_date);
  if (readyScheduled) {
    return {
      mode: 'publish_ready',
      title: readyScheduled.title,
      summary: `Ready to publish; the private target deadline is ${readyScheduled.scheduled_date}. No publishing slot is confirmed.`,
      scheduledDate: readyScheduled.scheduled_date,
      dateSemantics: 'private_deadline',
      calendarConfirmed: false,
      confidence: 'high',
      sourceType: 'topic_ready_deadline',
    };
  }

  const readyTopic = topics.find((topic) => topic.status === 'ready');
  if (readyTopic) {
    return {
      mode: 'publish_ready',
      title: readyTopic.title,
      summary: 'Ready to publish; no publishing slot is confirmed.',
      scheduledDate: readyTopic.scheduled_date,
      dateSemantics: 'none',
      calendarConfirmed: false,
      confidence: 'high',
      sourceType: 'topic_ready',
    };
  }

  const scriptReady = deskItems.find((item) => item.type === 'script_ready');
  if (scriptReady) {
    return {
      mode: 'script_ready',
      title: scriptReady.title,
      summary: scriptReady.body || 'Script is already on the desk and can move forward now.',
      scheduledDate: null,
      dateSemantics: 'none',
      calendarConfirmed: false,
      confidence: 'high',
      sourceType: 'desk_item',
    };
  }

  const reactionSignal = rankedSignals.find((signal) =>
    signal.type === 'reaction_opportunity'
    || signal.type === 'trending_spike'
    || signal.type === 'competitor_upload');
  if (reactionSignal) {
    return {
      mode: 'reaction_window',
      title: reactionSignal.title,
      summary: reactionSignal.summary,
      scheduledDate: null,
      dateSemantics: 'none',
      calendarConfirmed: false,
      confidence: reactionSignal.priority === 'urgent'
        ? 'high'
        : reactionSignal.confidence >= 0.6
          ? 'medium'
          : 'low',
      sourceType: reactionSignal.type,
    };
  }

  if (filmingRecommendation) {
    return {
      mode: 'film_window',
      title: 'Filming window',
      summary: `${filmingRecommendation.reason} This is a recommendation, not a reserved calendar block.`,
      scheduledDate: filmingRecommendation.date,
      dateSemantics: 'recommended_work_date',
      calendarConfirmed: false,
      confidence: filmingRecommendation.confidence,
      sourceType: 'filming_recommendation',
    };
  }

  const draftingTopic = topics.find((topic) => topic.status === 'drafting' || topic.status === 'planned');
  if (draftingTopic) {
    return {
      mode: 'discovery',
      title: draftingTopic.title,
      summary: draftingTopic.scheduled_date
        ? `There is already a topic in motion with a private target deadline of ${draftingTopic.scheduled_date}, but it still needs direction before execution.`
        : 'There is already a topic in motion, but it still needs direction before execution.',
      scheduledDate: draftingTopic.scheduled_date,
      dateSemantics: draftingTopic.scheduled_date ? 'private_deadline' : 'none',
      calendarConfirmed: false,
      confidence: 'medium',
      sourceType: 'topic_pipeline',
    };
  }

  if (pillars[0]) {
    return {
      mode: 'discovery',
      title: pillars[0].name,
      summary: 'This pillar is active, but it still needs a sharper angle before the next move.',
      scheduledDate: null,
      dateSemantics: 'none',
      calendarConfirmed: false,
      confidence: 'low',
      sourceType: 'pillar',
    };
  }

  return null;
}

export function localizeFilmingRecommendation<T extends {
  reason: string;
  reasons: string[];
  calendarReservationMessage?: string | null;
} | null>(
  recommendation: T,
  language: Lang,
): T {
  if (!recommendation || !language.startsWith('pt')) {
    return recommendation;
  }

  const localizedReasons = recommendation.reasons.map((reason) => localizeFilmingRecommendationText(reason, language));
  return {
    ...recommendation,
    reason: localizeFilmingRecommendationText(recommendation.reason, language),
    reasons: localizedReasons,
    calendarReservationMessage: recommendation.calendarReservationMessage
      ? localizeFilmingRecommendationText(recommendation.calendarReservationMessage, language)
      : recommendation.calendarReservationMessage,
  };
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function describeContentSignalTitle(signal: {
  signal_type: string;
  payload: Record<string, any>;
}): string {
  const title = firstText(
    signal.payload.title,
    signal.payload.topic,
    signal.payload.formula,
    signal.payload.keyword,
    signal.payload.pillar,
    signal.payload.hook,
  );
  if (title) return title;
  return humanizeContentSignalType(signal.signal_type);
}

function describeContentSignalSummary(signal: {
  signal_type: string;
  payload: Record<string, any>;
}): string {
  const summary = firstText(
    signal.payload.summary,
    signal.payload.reason,
    signal.payload.recommendation,
    signal.payload.reaction_angle,
    signal.payload.your_counter_position,
    signal.payload.pattern,
    signal.payload.observation,
    signal.payload.description,
  );
  if (summary) return summary;

  switch (signal.signal_type) {
    case 'reaction_opportunity':
      return 'Fast reaction window with enough context to move now.';
    case 'trending_spike':
      return 'This topic is gaining speed and timing matters.';
    case 'competitor_upload':
      return 'A comparable creator move may justify a response angle.';
    case 'pipeline_bottleneck': {
      const stage = firstText(signal.payload.bottleneck_stage) ?? 'pipeline';
      const count = typeof signal.payload.stuck_count === 'number' ? signal.payload.stuck_count : null;
      return count != null
        ? `${count} item(s) are stuck at ${stage}.`
        : `The ${stage} stage is starting to clog.`;
    }
    case 'hook_effectiveness':
      return 'A recent hook pattern is standing out in performance.';
    case 'pillar_performance':
      return 'One pillar is clearly outperforming the others.';
    case 'learning_digest':
    case 'creator_learning_digest':
      return 'The learning loop already has a durable pattern worth reusing.';
    case 'content_formula':
      return 'A repeatable format is emerging from recent content results.';
    default:
      return 'Recent content-system signal.';
  }
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function humanizeContentSignalType(type: string): string {
  return type
    .split('_')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function localizeFilmingRecommendationText(text: string, language: Lang): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;

  const numericPattern = /(\d+)\/100/g;

  switch (trimmed) {
    case 'No hard training is scheduled today.':
      return localizePTVariant(language, 'Hoje não há treino duro planeado.', 'Hoje não há treino pesado planejado.');
    case 'No hard training is planned for this day.':
      return localizePTVariant(language, 'Não há treino duro planeado para este dia.', 'Não há treino pesado planejado para este dia.');
    case 'There is a hard training session planned, so filming would compete with your best energy.':
      return localizePTVariant(language, 'Há um treino duro planeado, por isso filmar iria competir com a tua melhor energia.', 'Há um treino pesado planejado, por isso filmar competiria com a sua melhor energia.');
    case 'Training is planned, but it looks manageable around a filming block.':
      return localizePTVariant(language, 'Há treino planeado, mas parece compatível com um bloco de filmagem.', 'Há treino planejado, mas parece compatível com um bloco de filmagem.');
    case 'Only light training is planned, so it should be easier to film well.':
      return localizePTVariant(language, 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.', 'Só há treino leve planejado, por isso deve ser mais fácil filmar bem.');
    case 'Your calendar is clear, so you have room to film without collisions.':
      return localizePTVariant(language, 'O teu calendário está livre, por isso tens espaço para filmar sem conflitos.', 'O seu calendário está livre, por isso tem espaço para filmar sem conflitos.');
    case 'The calendar could not be confirmed, so treat this filming day as provisional.':
      return localizePTVariant(language, 'Não foi possível confirmar o calendário, por isso trata este dia de filmagem como provisório.', 'Não foi possível confirmar o calendário, por isso trate este dia de filmagem como provisório.');
    case 'Your calendar is busy that day, so filming would likely fragment or run late.':
      return localizePTVariant(language, 'O teu calendário está carregado nesse dia, por isso filmar iria fragmentar-se ou atrasar-se.', 'O seu calendário está cheio nesse dia, por isso filmar provavelmente iria fragmentar ou atrasar.');
    case 'You have a few calendar commitments, but there is still some room to film.':
      return localizePTVariant(language, 'Tens alguns compromissos no calendário, mas ainda há margem para filmar.', 'Você tem alguns compromissos no calendário, mas ainda há margem para filmar.');
    case 'The calendar looks light, which is good for a focused filming block.':
      return localizePTVariant(language, 'O calendário parece leve, o que é bom para um bloco de filmagem focado.', 'O calendário parece leve, o que é bom para um bloco de filmagem focado.');
    case 'You already have a content deadline on this date.':
      return localizePTVariant(language, 'Já tens um prazo de conteúdo nesta data.', 'Você já tem um prazo de conteúdo nesta data.');
    case 'Giving yourself one more recovery day should improve filming quality.':
      return localizePTVariant(language, 'Dar a ti próprio mais um dia de recuperação deve melhorar a qualidade da filmagem.', 'Dar a si mesmo mais um dia de recuperação deve melhorar a qualidade da filmagem.');
    case 'Recent recovery signals suggest protecting today rather than stacking filming on top.':
      return localizePTVariant(language, 'Os sinais recentes de recuperação sugerem proteger o dia de hoje em vez de acumular filmagem por cima.', 'Os sinais recentes de recuperação sugerem proteger o dia de hoje em vez de acumular filmagem por cima.');
    case 'This gives your current recovery dip a little more room to settle.':
      return localizePTVariant(language, 'Isto dá mais espaço para a tua quebra atual de recuperação estabilizar.', 'Isto dá mais espaço para a sua queda atual de recuperação estabilizar.');
    case 'Connect Google Calendar or Outlook in Settings to reserve this filming block.':
      return localizePTVariant(language, 'Liga o Google Calendar ou o Outlook nas Definições para reservar este bloco de filmagem.', 'Conecte o Google Calendar ou o Outlook nas Configurações para reservar este bloco de filmagem.');
    case 'This day has the cleanest mix of energy and calendar space for filming.':
      return localizePTVariant(language, 'Este dia tem a melhor combinação de energia e espaço no calendário para filmar.', 'Este dia tem a melhor combinação de energia e espaço no calendário para filmar.');
    default:
      break;
  }

  if (trimmed.startsWith("Today's readiness is only ")) {
    return trimmed.replace(
      /^Today's readiness is only (\d+)\/100, so filming tomorrow or later is safer\.$/,
      'A prontidão de hoje é só $1/100, por isso é mais seguro filmar amanhã ou mais tarde.',
    );
  }

  if (trimmed.startsWith('Readiness looks solid at ')) {
    return trimmed.replace(
      /^Readiness looks solid at (\d+)\/100, which supports a focused filming block\.$/,
      'A prontidão está sólida em $1/100, o que ajuda um bloco de filmagem focado.',
    );
  }

  return trimmed.replace(numericPattern, '$1/100');
}

function localizePTVariant(language: Lang, portugal: string, brazil: string): string {
  return language === 'pt-BR' ? brazil : portugal;
}
