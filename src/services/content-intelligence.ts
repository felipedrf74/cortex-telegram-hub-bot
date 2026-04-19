// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getUnreadNotifications } from './content-notification-store';
import { getDb } from './database';
import { logger } from '../utils/logger';
import type { Lang } from '../utils/i18n';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

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

export function getActiveContentPillars(userId: number): ContentPillarSummary[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidContentIntelligenceScope('get_active_content_pillars', userId);
    return [];
  }

  try {
    const rows = getDb().prepare(`
      SELECT name, keywords, weight, user_id
      FROM config_pillars
      WHERE enabled = 1
        AND user_id IN (0, ?)
      ORDER BY weight DESC, user_id DESC, name ASC
    `).all(userId) as Array<{ name: string; keywords: string | null; user_id: number; weight: number }>;

    const hasUserScopedRows = rows.some((row) => row.user_id === userId);
    const scopedRows = hasUserScopedRows
      ? rows.filter((row) => (
        row.user_id === userId
        || (row.user_id === 0 && Number(row.weight ?? 0) > 1)
      ))
      : rows.filter((row) => row.user_id === 0).slice(0, 6);

    const deduped = new Map<string, ContentPillarSummary>();
    for (const row of scopedRows) {
      if (!deduped.has(row.name)) {
        deduped.set(row.name, {
          name: row.name,
          keywordCount: safeJsonArray(row.keywords).length,
        });
      }
    }
    return Array.from(deduped.values());
  } catch (err) {
    logger.debug({ err, userId }, 'Content intelligence: active pillars query failed');
    return [];
  }
}

export function getContentDeskItems(userId: number, limit: number): ContentDeskItem[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidContentIntelligenceScope('get_content_desk_items', userId, { limit });
    return [];
  }

  try {
    return getUnreadNotifications(userId, limit * 3)
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
  } catch (err) {
    logger.debug({ err, userId }, 'Content intelligence: desk items query failed');
    return [];
  }
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
