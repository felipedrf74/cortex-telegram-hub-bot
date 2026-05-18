// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { getFilmingRecommendation, getTopics, getUpcomingTopicCount, type ContentTopic } from '../../services/content-scheduler';
import { getLearnedPatterns, getPerformanceSummary } from '../../services/content-learning-store';
import { getAllVendors as getAllInvoiceVendors } from '../../services/invoice-collector';
import { getFilingsForMonth } from '../../state/invoice-filings';
import { getSubscriptionStatus } from '../../services/stripe-service';
import { calculatePortugueseMonthlyTax, formatCurrencyAmount, getMonthlyBudgetView, getMonthlySummary, getTaxEvents } from '../../services/finance-tracker';
import { getFiscalCollectionSummary } from '../../services/fiscal-bundle';
import {
  getActiveContentPillars,
  getContentDeskItems,
  getNextContentExecutionHint,
  getRankedContentSignals,
  localizeFilmingRecommendation,
} from '../../services/content-intelligence';
import type { ContentStateShortcut, FinanceStateShortcut, ShortcutLanguage } from './chat-shortcut-parsers';

function formatContentShortcutDate(date: string, language: ShortcutLanguage): string {
  const locale = language === 'en-US' ? 'en-US' : language === 'pt-PT' ? 'pt-PT' : 'pt-BR';
  const formatter = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  return formatter.format(new Date(`${date}T12:00:00Z`));
}

function describeDeskItemType(type: string, language: ShortcutLanguage): string {
  switch (type) {
    case 'script_ready':
      return language === 'en-US' ? 'Script ready' : 'Roteiro pronto';
    case 'topic_candidates_ready':
      return language === 'en-US' ? 'Ideas ready' : 'Ideias prontas';
    case 'weekly_package_ready':
      return language === 'en-US' ? 'Weekly package ready' : 'Pacote semanal pronto';
    default:
      return language === 'en-US' ? 'Ready item' : 'Item pronto';
  }
}

function formatOptionalTopicDate(
  date: string | null,
  language: ShortcutLanguage,
): string | null {
  if (!date) return null;
  return formatContentShortcutDate(date, language);
}

function chooseNextContentPriority(
  topics: ContentTopic[],
): ContentTopic | null {
  const rankedStatuses: Array<ContentTopic['status']> = ['ready', 'drafting', 'planned'];
  for (const status of rankedStatuses) {
    const scheduled = topics.find((topic) => topic.status === status && topic.scheduled_date);
    if (scheduled) return scheduled;
    const unscheduled = topics.find((topic) => topic.status === status);
    if (unscheduled) return unscheduled;
  }
  return null;
}

function formatExecutionConfidence(
  confidence: 'high' | 'medium' | 'low',
  language: ShortcutLanguage,
): string {
  if (language === 'en-US') return confidence;
  switch (confidence) {
    case 'high':
      return 'alta';
    case 'medium':
      return 'média';
    case 'low':
    default:
      return 'baixa';
  }
}

function formatViews(value: number, language: ShortcutLanguage): string {
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function localizeContentPatternCategory(category: string, language: ShortcutLanguage): string {
  const labels: Record<string, { en: string; pt: string }> = {
    hook_effectiveness: { en: 'Hook performance', pt: 'Performance dos hooks' },
    pillar_performance: { en: 'Pillar performance', pt: 'Performance dos pilares' },
    learning_digest: { en: 'Weekly learning', pt: 'Aprendizagem semanal' },
    content_formula: { en: 'Winning format', pt: 'Formato vencedor' },
    retention_pattern: { en: 'Retention pattern', pt: 'Padrão de retenção' },
    voice_pattern: { en: 'Voice pattern', pt: 'Padrão de voz' },
  };
  const label = labels[category.trim().toLowerCase()];
  if (label) return language === 'en-US' ? label.en : label.pt;
  return category.replace(/_/g, ' ');
}

function formatFinanceMonthLabel(month: string, language: ShortcutLanguage): string {
  const date = DateTime.fromFormat(month, 'yyyy-MM').startOf('month');
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date.toJSDate());
}

function formatFinanceDate(value: string, language: ShortcutLanguage): string {
  const date = DateTime.fromISO(value);
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(date.toJSDate());
}

function formatFiscalProviderLabel(provider: string): string {
  switch (provider) {
    case 'gmail':
      return 'Gmail';
    case 'outlook':
      return 'Outlook';
    default:
      return provider;
  }
}

export async function buildContentStateShortcutResponse(
  shortcut: ContentStateShortcut,
  userId: number,
  language: ShortcutLanguage,
): Promise<{ text: string; metadata: Record<string, unknown> }> {
  switch (shortcut) {
    case 'desk': {
      const items = getContentDeskItems(userId, 3);
      if (items.length === 0) {
        return {
          text: language === 'en-US'
            ? 'There is nothing desk-ready right now. The content desk is still warming up.'
            : 'Não há nada pronto na sua mesa agora. A mesa de conteúdo ainda está aquecendo.',
          metadata: { type: 'content_desk_snapshot', deskReadyCount: 0, deskItems: [] },
        };
      }

      const lines = items.map((item) => `• ${describeDeskItemType(item.type, language)} — ${item.title}`);
      return {
        text: language === 'en-US'
          ? `This is already on your desk right now:\n\n${lines.join('\n')}\n\nOpen Content to review, refine, or move these items forward.`
          : `Isto já está na sua mesa agora:\n\n${lines.join('\n')}\n\nAbra Conteúdo para revisar, lapidar, ou empurrar estes itens no pipeline.`,
        metadata: { type: 'content_desk_snapshot', deskReadyCount: items.length, deskItems: items },
      };
    }
    case 'pillars': {
      const pillars = getActiveContentPillars(userId);
      if (pillars.length === 0) {
        return {
          text: language === 'en-US'
            ? 'I do not see any active content pillars yet. Configure them in Content so discovery can stay focused.'
            : 'Ainda não vejo pilares de conteúdo ativos. Configure isso em Conteúdo para a descoberta ficar focada.',
          metadata: { type: 'content_pillars_snapshot', monitoredPillars: [] },
        };
      }

      const lines = pillars.map((pillar) => `• ${pillar.name} (${pillar.keywordCount} ${language === 'en-US' ? 'keywords' : 'palavras-chave'})`);
      return {
        text: language === 'en-US'
          ? `These are the pillars you are actively tracking right now:\n\n${lines.join('\n')}`
          : `Estes são os pilares que você está acompanhando agora:\n\n${lines.join('\n')}`,
        metadata: { type: 'content_pillars_snapshot', monitoredPillars: pillars },
      };
    }
    case 'filming': {
      const recommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);
      const upcomingCount = getUpcomingTopicCount(userId, 7);
      if (!recommendation) {
        return {
          text: language === 'en-US'
            ? `I do not have a strong filming recommendation yet. You have ${upcomingCount} scheduled content item(s) in the next 7 days.`
            : `Ainda não tenho uma recomendação forte de filmagem. Há ${upcomingCount} item(ns) de conteúdo agendado(s) para os próximos 7 dias.`,
          metadata: { type: 'content_filming_snapshot', filmingRecommendation: null, upcomingCount },
        };
      }

      const block = recommendation.blockStart && recommendation.blockEnd
        ? (language === 'en-US'
          ? `• Suggested block: ${recommendation.blockStart.slice(11, 16)}-${recommendation.blockEnd.slice(11, 16)}`
          : `• Bloco sugerido: ${recommendation.blockStart.slice(11, 16)}-${recommendation.blockEnd.slice(11, 16)}`)
        : null;
      const reservation = recommendation.calendarReservationMessage
        ? `• ${recommendation.calendarReservationMessage}`
        : null;
      const lines = [
        language === 'en-US'
          ? `• Best day: ${formatContentShortcutDate(recommendation.date, language)}`
          : `• Melhor dia: ${formatContentShortcutDate(recommendation.date, language)}`,
        language === 'en-US'
          ? `• Confidence: ${recommendation.confidence}`
          : `• Confiança: ${recommendation.confidence}`,
        block,
        `• ${recommendation.reason}`,
        language === 'en-US'
          ? `• Upcoming scheduled topics: ${upcomingCount}`
          : `• Tópicos agendados para os próximos 7 dias: ${upcomingCount}`,
        reservation,
      ].filter((line): line is string => Boolean(line));

      return {
        text: language === 'en-US'
          ? `This is the best filming window I can see for your week:\n\n${lines.join('\n')}`
          : `Esta é a melhor janela de filmagem que vejo para esta semana:\n\n${lines.join('\n')}`,
        metadata: {
          type: 'content_filming_snapshot',
          filmingRecommendation: recommendation,
          upcomingCount,
        },
      };
    }
    case 'next_publish': {
      const topics = getTopics(userId, { includeTerminal: false, limit: 50 });
      const nextTopic = chooseNextContentPriority(topics);
      const deskItems = getContentDeskItems(userId, 3);
      const scriptReady = deskItems.find((item) => item.type === 'script_ready');
      const rankedSignals = getRankedContentSignals(userId, 3);
      const nextExecution = await getNextContentExecutionHint(userId, {
        topics,
        deskItems,
        rankedSignals,
      });

      if (nextTopic) {
        const dateLabel = formatOptionalTopicDate(nextTopic.scheduled_date, language);
        const statusLabel = language === 'en-US'
          ? nextTopic.status
          : nextTopic.status === 'ready'
            ? 'pronto'
            : nextTopic.status === 'drafting'
              ? 'em rascunho'
              : 'planejado';
        const nextStep = nextTopic.status === 'ready'
          ? (language === 'en-US'
            ? 'This is the strongest next publish candidate in your pipeline.'
            : 'Este é o candidato mais forte para publicar a seguir no seu pipeline.')
          : (language === 'en-US'
            ? 'This is the clearest next content priority, but it still needs work before publish.'
            : 'Esta é a prioridade mais clara de conteúdo, mas ainda precisa de trabalho antes de publicar.');
        const scheduleLine = dateLabel
          ? (language === 'en-US'
            ? `• Scheduled for: ${dateLabel}`
            : `• Agendado para: ${dateLabel}`)
          : null;

        return {
          text: `${nextStep}\n\n• ${nextTopic.title}\n• Status: ${statusLabel}${scheduleLine ? `\n${scheduleLine}` : ''}`,
          metadata: {
            type: 'content_next_publish_snapshot',
            nextTopic: {
              id: nextTopic.id,
              title: nextTopic.title,
              status: nextTopic.status,
              scheduledDate: nextTopic.scheduled_date,
            },
            deskReadyCount: deskItems.length,
          },
        };
      }

      if (scriptReady) {
        return {
          text: language === 'en-US'
            ? `The clearest next publish candidate is already on your desk:\n\n• ${scriptReady.title}\n\nOpen Content to review the script and move it forward.`
            : `O candidato mais claro para publicar a seguir já está na sua mesa:\n\n• ${scriptReady.title}\n\nAbra Conteúdo para rever o roteiro e avançar com ele.`,
          metadata: {
            type: 'content_next_publish_snapshot',
            nextDeskItem: scriptReady,
            deskReadyCount: deskItems.length,
          },
        };
      }

      if (nextExecution && nextExecution.mode !== 'discovery') {
        const confidenceLine = language === 'en-US'
          ? `• Confidence: ${formatExecutionConfidence(nextExecution.confidence, language)}`
          : `• Confiança: ${formatExecutionConfidence(nextExecution.confidence, language)}`;

        const responseByMode: Partial<Record<typeof nextExecution.mode, string>> = {
          publish_ready: language === 'en-US'
            ? `The clearest next publish candidate is already lined up:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nOpen Content to ship it while the window is clean.`
            : `O próximo candidato mais claro para publicar já está alinhado:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nAbra Conteúdo para o colocar no ar enquanto a janela ainda está limpa.`,
          reaction_window: language === 'en-US'
            ? `The strongest next content move is to react while this window is still fresh:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nOpen Content to turn this into a script or capture block before the signal cools off.`
            : `A jogada mais forte de conteúdo agora é reagir enquanto esta janela ainda está fresca:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nAbra Conteúdo para transformar isto num roteiro ou bloco de captação antes de o sinal arrefecer.`,
          film_window: language === 'en-US'
            ? `The clearest next content move is to protect the filming window for:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nOpen Content to reserve the block and keep production moving.`
            : `A jogada mais clara de conteúdo agora é proteger a janela de filmagem para:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nAbra Conteúdo para reservar o bloco e manter a produção a andar.`,
          script_ready: language === 'en-US'
            ? `The clearest next content move is already script-ready:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nOpen Content to review the script and move it forward.`
            : `A jogada mais clara de conteúdo já está com roteiro pronto:\n\n• ${nextExecution.title}\n${confidenceLine}\n\nAbra Conteúdo para rever o roteiro e avançar com ele.`,
        };

        const text = responseByMode[nextExecution.mode];
        if (text) {
          return {
            text,
            metadata: {
              type: 'content_next_publish_snapshot',
              nextTopic: null,
              deskReadyCount: deskItems.length,
              candidateMode: nextExecution.mode,
              candidateTitle: nextExecution.title,
              confidence: nextExecution.confidence,
              sourceType: nextExecution.sourceType,
              topSignalType: rankedSignals[0]?.type ?? null,
            },
          };
        }
      }

      return {
        text: language === 'en-US'
          ? 'I do not see a clear next publish candidate yet. Open Content to promote a topic into drafting or generate a fresh script package.'
          : 'Ainda não vejo um próximo candidato claro para publicar. Abra Conteúdo para promover um tema para rascunho ou gerar um novo pacote de roteiro.',
        metadata: {
          type: 'content_next_publish_snapshot',
          nextTopic: null,
          deskReadyCount: deskItems.length,
        },
      };
    }
    case 'performance': {
      const summary = getPerformanceSummary(userId, 30);
      if (summary.count === 0) {
        return {
          text: language === 'en-US'
            ? 'I do not have any logged content performance yet. Publish something first, then I can tell you what is actually winning.'
            : 'Ainda não tenho performance de conteúdo registada. Publique algo primeiro e depois consigo dizer o que está a ganhar.',
          metadata: {
            type: 'content_performance_snapshot',
            count: 0,
            bestByViews: null,
            bestByRetention: null,
          },
        };
      }

      const bestByViews = summary.entries.reduce((best, current) => current.views > best.views ? current : best, summary.entries[0]);
      const bestByRetention = summary.entries.reduce((best, current) => current.retentionPct > best.retentionPct ? current : best, summary.entries[0]);
      const sameEntryLeads = bestByViews.id === bestByRetention.id;
      const viewsLine = language === 'en-US'
        ? `• Best by views: ${bestByViews.videoUrl || 'Logged video'} (${formatViews(bestByViews.views, language)} views)`
        : `• Melhor em views: ${bestByViews.videoUrl || 'Vídeo registado'} (${formatViews(bestByViews.views, language)} views)`;
      const retentionLine = language === 'en-US'
        ? `• Best by retention: ${bestByRetention.videoUrl || 'Logged video'} (${bestByRetention.retentionPct}% retention)`
        : `• Melhor em retenção: ${bestByRetention.videoUrl || 'Vídeo registado'} (${bestByRetention.retentionPct}% de retenção)`;
      const averageLine = language === 'en-US'
        ? `• 30-day average: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% retention`
        : `• Média de 30 dias: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% de retenção`;
      const headline = sameEntryLeads
        ? (language === 'en-US'
          ? 'One content piece is clearly leading your recent performance.'
          : 'Uma peça de conteúdo está claramente a liderar a tua performance recente.')
        : (language === 'en-US'
          ? 'Your recent performance has a clear winner by views and another by retention.'
          : 'A tua performance recente tem um vencedor claro em views e outro em retenção.');

      return {
        text: `${headline}\n\n${viewsLine}\n${retentionLine}\n${averageLine}`,
        metadata: {
          type: 'content_performance_snapshot',
          count: summary.count,
          avgViews: summary.avgViews,
          avgRetention: summary.avgRetention,
          bestByViews: {
            id: bestByViews.id,
            videoUrl: bestByViews.videoUrl,
            views: bestByViews.views,
            retentionPct: bestByViews.retentionPct,
          },
          bestByRetention: {
            id: bestByRetention.id,
            videoUrl: bestByRetention.videoUrl,
            views: bestByRetention.views,
            retentionPct: bestByRetention.retentionPct,
          },
        },
      };
    }
    case 'learning': {
      const patterns = getLearnedPatterns(userId).slice(0, 3);
      if (patterns.length === 0) {
        const summary = getPerformanceSummary(userId, 30);
        if (summary.count > 0) {
          return {
            text: language === 'en-US'
              ? `There is already performance history, but not a strong enough pattern yet to count as durable learning.\n\n• 30-day average: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% retention\n• Next step: log the hooks used and post-publish notes so the system can lock in what is working.`
              : `Já existe histórico de performance, mas ainda não há um padrão forte o suficiente para virar aprendizagem durável.\n\n• Média de 30 dias: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% de retenção\n• Próximo passo: registar os hooks usados e as notas pós-publicação para consolidar o que está funcionando.`,
            metadata: {
              type: 'content_learning_snapshot',
              count: 0,
              avgViews: summary.avgViews,
              avgRetention: summary.avgRetention,
              patterns: [],
            },
          };
        }

        return {
          text: language === 'en-US'
            ? 'There is not enough logged learning yet to answer this confidently. As new results and patterns come in, I will summarize what is working across hooks, format, and retention.'
            : 'Ainda não existe aprendizagem suficiente registada para responder com confiança. À medida que novos resultados e padrões entram, eu resumo o que está funcionando em hook, formato e retenção.',
          metadata: {
            type: 'content_learning_snapshot',
            count: 0,
            patterns: [],
          },
        };
      }

      const lines = patterns.map((pattern) => {
        const label = localizeContentPatternCategory(pattern.category, language);
        const confidence = Math.round(pattern.confidence * 100);
        return language === 'en-US'
          ? `• ${label}: ${pattern.patternText} (${confidence}% confidence, seen ${pattern.frequency}x)`
          : `• ${label}: ${pattern.patternText} (${confidence}% de confiança, visto ${pattern.frequency}x)`;
      });

      return {
        text: language === 'en-US'
          ? `Here is what the learning loop is picking up right now:\n\n${lines.join('\n')}`
          : `Isto é o que o loop de aprendizagem está vendo agora:\n\n${lines.join('\n')}`,
        metadata: {
          type: 'content_learning_snapshot',
          count: patterns.length,
          patterns: patterns.map((pattern) => ({
            id: pattern.id,
            category: pattern.category,
            patternText: pattern.patternText,
            confidence: pattern.confidence,
            frequency: pattern.frequency,
          })),
        },
      };
    }
  }
}

export function buildFinanceStateShortcutResponse(
  shortcut: FinanceStateShortcut,
  userId: number,
  language: ShortcutLanguage,
  tenantId?: number,
): { text: string; metadata: Record<string, unknown> } {
  const financeScope = tenantId && Number.isInteger(tenantId) && tenantId > 0 ? { tenantId } : undefined;
  switch (shortcut) {
    case 'missing_bills': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const vendors = getAllInvoiceVendors(userId);
      const filings = getFilingsForMonth(now.year, now.month, userId).filter((filing) => filing.status === 'filed');
      const filedVendors = [...new Set(filings.map((filing) => filing.vendor.trim()))];
      const filedVendorNames = new Set(filedVendors.map((vendor) => vendor.toLowerCase()));
      const missingVendors = vendors
        .filter((vendor) => !filedVendorNames.has(vendor.name.toLowerCase()))
        .map((vendor) => vendor.name);
      const monthLabel = formatFinanceMonthLabel(now.toFormat('yyyy-MM'), language);

      if (vendors.length === 0) {
        return {
          text: language === 'en-US'
            ? 'I do not see any tracked invoice vendors yet. Add them in Fiscal Collection so I can tell you what is still missing each month.'
            : 'Ainda não vejo fornecedores acompanhados na recolha fiscal. Adicione-os em Recolha fiscal para eu dizer o que ainda falta em cada mês.',
          metadata: {
            type: 'finance_missing_bills_snapshot',
            month: now.toFormat('yyyy-MM'),
            trackedVendorCount: 0,
            filedVendorCount: 0,
            missingVendors: [],
            filedVendors: [],
          },
        };
      }

      if (missingVendors.length === 0) {
        return {
          text: language === 'en-US'
            ? `Nothing looks missing for ${monthLabel} across your tracked invoice vendors.\n\n• Tracked vendors: ${vendors.length}\n• Filed this month: ${filedVendors.length}`
            : `Nada parece estar em falta para ${monthLabel} nos seus fornecedores acompanhados.\n\n• Fornecedores acompanhados: ${vendors.length}\n• Com fatura registada este mês: ${filedVendors.length}`,
          metadata: {
            type: 'finance_missing_bills_snapshot',
            month: now.toFormat('yyyy-MM'),
            trackedVendorCount: vendors.length,
            filedVendorCount: filedVendors.length,
            missingVendors: [],
            filedVendors,
          },
        };
      }

      const preview = missingVendors.slice(0, 5).map((vendor) => `• ${vendor}`).join('\n');
      const remainder = missingVendors.length > 5
        ? (language === 'en-US'
          ? `\n• +${missingVendors.length - 5} more tracked vendors`
          : `\n• +${missingVendors.length - 5} fornecedores acompanhados`)
        : '';

      return {
        text: language === 'en-US'
          ? `These tracked bills still look missing for ${monthLabel}:\n\n${preview}${remainder}\n\n• Filed this month: ${filedVendors.length} of ${vendors.length}`
          : `Estas contas acompanhadas ainda parecem em falta em ${monthLabel}:\n\n${preview}${remainder}\n\n• Registadas este mês: ${filedVendors.length} de ${vendors.length}`,
        metadata: {
          type: 'finance_missing_bills_snapshot',
          month: now.toFormat('yyyy-MM'),
          trackedVendorCount: vendors.length,
          filedVendorCount: filedVendors.length,
          missingVendors,
          filedVendors,
        },
      };
    }
    case 'subscription_renewal': {
      const subscription = getSubscriptionStatus(userId);
      if (!subscription.isActive || !subscription.currentPeriodEnd) {
        return {
          text: language === 'en-US'
            ? 'Right now the durable renewal tracker only has Nexus Hub subscription state, and I do not see an active renewal scheduled.'
            : 'Neste momento o rastreador durável de renovações só tem o estado da subscrição do Nexus Hub, e eu não vejo nenhuma renovação ativa agendada.',
          metadata: {
            type: 'finance_subscription_snapshot',
            trackedSubscriptions: 0,
            renewalDueSoon: false,
            subscription: null,
          },
        };
      }

      const renewalDate = DateTime.fromISO(subscription.currentPeriodEnd);
      const daysUntil = Math.ceil(renewalDate.diffNow('days').days);
      const renewalDueSoon = daysUntil <= 14;
      const planLabel = `${subscription.plan} ${subscription.period}`;
      const statusLine = subscription.cancelAtPeriodEnd
        ? (language === 'en-US' ? 'Scheduled to end at period close' : 'Agendada para terminar no fecho do período')
        : (language === 'en-US' ? 'Auto-renew is still on' : 'A renovação automática continua ativa');

      return {
        text: language === 'en-US'
          ? `Right now the durable renewal tracker only includes Nexus Hub.\n\n• Plan: ${planLabel}\n• ${renewalDueSoon ? 'Renews soon' : 'Next renewal'}: ${formatFinanceDate(subscription.currentPeriodEnd, language)} (${daysUntil} day${daysUntil === 1 ? '' : 's'})\n• ${statusLine}`
          : `Neste momento o rastreador durável de renovações inclui apenas o Nexus Hub.\n\n• Plano: ${planLabel}\n• ${renewalDueSoon ? 'Renova em breve' : 'Próxima renovação'}: ${formatFinanceDate(subscription.currentPeriodEnd, language)} (${daysUntil} dia${daysUntil === 1 ? '' : 's'})\n• ${statusLine}`,
        metadata: {
          type: 'finance_subscription_snapshot',
          trackedSubscriptions: 1,
          renewalDueSoon,
          subscription: {
            plan: subscription.plan,
            period: subscription.period,
            status: subscription.status,
            provider: subscription.provider,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          },
        },
      };
    }
    case 'budget_remaining': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const summary = getMonthlySummary(userId, month, financeScope);
      const budgetView = getMonthlyBudgetView(userId, month, financeScope);
      const remaining = Math.max(summary.totalIncome - summary.totalExpenses, 0);
      const remainingRatio = summary.totalIncome > 0
        ? Math.round((remaining / summary.totalIncome) * 100)
        : 0;

      if (budgetView.integrity === 'mixed_currency') {
        return {
          text: language === 'en-US'
            ? `Your ${monthLabel} budget posture is provisional because Nexus found mixed currencies (${budgetView.currencies.join(', ')}) in the same month.\n\n• Reliable basis right now: ${budgetView.basisCurrency}\n• Income logged in ${budgetView.basisCurrency}: ${formatViews(budgetView.incomeInBasisCurrency, language)}\n• Expenses logged in ${budgetView.basisCurrency}: ${formatViews(budgetView.expensesInBasisCurrency, language)}\n• Next step: normalize or separate those currencies before using this month as a real budget guardrail.`
            : `A leitura do teu orçamento em ${monthLabel} ainda é provisória porque o Nexus encontrou moedas misturadas (${budgetView.currencies.join(', ')}) no mesmo mês.\n\n• Base fiável neste momento: ${budgetView.basisCurrency}\n• Rendimento registado em ${budgetView.basisCurrency}: ${formatViews(budgetView.incomeInBasisCurrency, language)}\n• Despesas registadas em ${budgetView.basisCurrency}: ${formatViews(budgetView.expensesInBasisCurrency, language)}\n• Próximo passo: normalizar ou separar essas moedas antes de usar este mês como travão real de orçamento.`,
          metadata: {
            type: 'finance_budget_snapshot',
            month,
            totalIncome: summary.totalIncome,
            totalExpenses: summary.totalExpenses,
            remaining,
            remainingRatio: null,
            transactionCount: summary.transactionCount,
            integrity: budgetView.integrity,
            basisCurrency: budgetView.basisCurrency,
            currencies: budgetView.currencies,
            recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
            recurringExpenseCount: budgetView.recurringExpenseCount,
            derived: false,
          },
        };
      }

      if (summary.totalIncome <= 0) {
        return {
          text: language === 'en-US'
            ? `I do not have any logged income for ${monthLabel} yet, so I cannot compute a real remaining budget from your actual numbers.\n\n• Logged expenses so far: ${formatViews(summary.totalExpenses, language)}\n• Logged transactions: ${summary.transactionCount}`
            : `Ainda não tenho rendimento registado para ${monthLabel}, por isso não consigo calcular um orçamento restante real a partir dos seus números.\n\n• Despesas registadas até agora: ${formatViews(summary.totalExpenses, language)}\n• Transações registadas: ${summary.transactionCount}`,
          metadata: {
            type: 'finance_budget_snapshot',
            month,
            totalIncome: summary.totalIncome,
            totalExpenses: summary.totalExpenses,
            remaining,
            remainingRatio,
            transactionCount: summary.transactionCount,
            integrity: budgetView.integrity,
            basisCurrency: budgetView.basisCurrency,
            recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
            recurringExpenseCount: budgetView.recurringExpenseCount,
            derived: false,
          },
        };
      }

      const recurringLine = budgetView.recurringExpenseEstimate > 0
        ? (language === 'en-US'
          ? `\n• Still likely this month in recurring commitments: ${formatCurrencyAmount(budgetView.basisCurrency, budgetView.recurringExpenseEstimate)} across ${budgetView.recurringExpenseCount} item(s)`
          : `\n• Ainda prováveis este mês em compromissos recorrentes: ${formatCurrencyAmount(budgetView.basisCurrency, budgetView.recurringExpenseEstimate)} em ${budgetView.recurringExpenseCount} item(ns)`)
        : '';

      return {
        text: language === 'en-US'
          ? `This is your remaining budget view for ${monthLabel} based on logged income vs expenses.\n\n• Income logged: ${formatViews(summary.totalIncome, language)}\n• Expenses logged: ${formatViews(summary.totalExpenses, language)}\n• Remaining: ${formatViews(remaining, language)} (${remainingRatio}% left)${recurringLine}`
          : `Esta é a sua visão de orçamento restante para ${monthLabel}, com base no rendimento e nas despesas registadas.\n\n• Rendimento registado: ${formatViews(summary.totalIncome, language)}\n• Despesas registadas: ${formatViews(summary.totalExpenses, language)}\n• Restante: ${formatViews(remaining, language)} (${remainingRatio}% disponível)${recurringLine}`,
        metadata: {
          type: 'finance_budget_snapshot',
          month,
          totalIncome: summary.totalIncome,
          totalExpenses: summary.totalExpenses,
          remaining,
          remainingRatio,
          transactionCount: summary.transactionCount,
          integrity: budgetView.integrity,
          basisCurrency: budgetView.basisCurrency,
          recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
          recurringExpenseCount: budgetView.recurringExpenseCount,
          derived: true,
        },
      };
    }
    case 'next_tax_due': {
      const pendingEvent = getTaxEvents(userId, { limit: 24, tenantId }).find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
      if (pendingEvent) {
        const invoiceCode = typeof pendingEvent.pt_invoice_code === 'string' && pendingEvent.pt_invoice_code.trim()
          ? pendingEvent.pt_invoice_code
          : null;
        const ivaLine = typeof pendingEvent.iva_due === 'number' && pendingEvent.iva_due > 0
          ? (language === 'en-US'
            ? `\n• IVA estimate: ${formatViews(pendingEvent.iva_due, language)}`
            : `\n• IVA estimado: ${formatViews(pendingEvent.iva_due, language)}`)
          : '';
        const withholdingLine = typeof pendingEvent.withholding_due === 'number' && pendingEvent.withholding_due > 0
          ? (language === 'en-US'
            ? `\n• Withholding estimate: ${formatViews(pendingEvent.withholding_due, language)}`
            : `\n• Retenção estimada: ${formatViews(pendingEvent.withholding_due, language)}`)
          : '';
        const invoiceLine = invoiceCode
          ? (language === 'en-US'
            ? `\n• PT invoice code: ${invoiceCode}`
            : `\n• Código de fatura PT: ${invoiceCode}`)
          : '';
        return {
          text: language === 'en-US'
            ? `The next stored Portugal tax estimate is the ${pendingEvent.month} IRS / IVA entry.\n\n• IRS estimate: ${formatViews(pendingEvent.tax_due, language)}${ivaLine}${withholdingLine}${invoiceLine}\n• Status: ${pendingEvent.status}`
            : `A próxima estimativa fiscal portuguesa registada em aberto é a entrada de IRS / IVA de ${pendingEvent.month}.\n\n• IRS estimado: ${formatViews(pendingEvent.tax_due, language)}${ivaLine}${withholdingLine}${invoiceLine}\n• Estado: ${pendingEvent.status}`,
          metadata: {
            type: 'finance_tax_snapshot',
            month: pendingEvent.month,
            taxDue: pendingEvent.tax_due,
            inssDue: pendingEvent.inss_due,
            ivaDue: pendingEvent.iva_due ?? null,
            withholdingDue: pendingEvent.withholding_due ?? null,
            ptInvoiceCode: invoiceCode,
            status: pendingEvent.status,
            derived: false,
          },
        };
      }

      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const summary = getMonthlySummary(userId, month, financeScope);
      if (summary.totalIncome > 0 || summary.totalDeductions > 0) {
        const preview = calculatePortugueseMonthlyTax(summary.totalIncome, summary.totalDeductions);
        return {
          text: language === 'en-US'
            ? `I do not see a stored pending tax event, but the current ${month} numbers point to this Portugal tax preview.\n\n• Gross income: ${formatViews(summary.totalIncome, language)}\n• Deductions: ${formatViews(summary.totalDeductions, language)}\n• Estimated IRS: ${formatViews(preview.taxDue, language)}\n• Estimated IVA: ${formatViews(preview.ivaDue ?? 0, language)}`
            : `Não vejo um evento fiscal pendente já registado, mas os números atuais de ${month} apontam para esta prévia fiscal portuguesa.\n\n• Rendimento bruto: ${formatViews(summary.totalIncome, language)}\n• Deduções: ${formatViews(summary.totalDeductions, language)}\n• IRS estimado: ${formatViews(preview.taxDue, language)}\n• IVA estimado: ${formatViews(preview.ivaDue ?? 0, language)}`,
          metadata: {
            type: 'finance_tax_snapshot',
            month,
            taxDue: preview.taxDue,
            inssDue: preview.inssDue,
            ivaDue: preview.ivaDue,
            withholdingDue: preview.withholdingDue,
            ptInvoiceCode: preview.ptInvoiceCode,
            status: 'preview',
            derived: true,
          },
        };
      }

      return {
        text: language === 'en-US'
          ? 'I do not see any stored pending tax event right now, and there is not enough logged income yet to preview the next Portugal tax estimate confidently.'
          : 'Não vejo nenhum evento fiscal pendente registado neste momento, e ainda não há rendimento suficiente registado para prever a próxima estimativa fiscal portuguesa com confiança.',
        metadata: {
          type: 'finance_tax_snapshot',
          month: null,
          taxDue: null,
          inssDue: null,
          status: 'none',
          derived: false,
        },
      };
    }
    case 'accountant_bundle': {
      const summary = getFiscalCollectionSummary(userId);
      const connectedProviders = summary.providers
        .filter((provider) => provider.connected)
        .map((provider) => formatFiscalProviderLabel(provider.provider));
      const warningSet = new Set(summary.warnings);
      const destinationLine = summary.destinationEmail
        ? summary.destinationEmail
        : (language === 'en-US' ? 'Missing destination email' : 'E-mail de destino em falta');
      const cadenceLine = summary.profile.cadence === 'twice_monthly'
        ? (language === 'en-US' ? 'Twice monthly' : 'Duas vezes por mês')
        : (language === 'en-US' ? 'Monthly' : 'Mensal');
      const lastBundleLine = summary.profile.last_bundle_sent_at
        ? formatFinanceDate(summary.profile.last_bundle_sent_at, language)
        : (language === 'en-US' ? 'No bundle sent yet' : 'Ainda não foi enviado nenhum bundle');
      const nextRunLine = summary.nextRunAt
        ? formatFinanceDate(summary.nextRunAt, language)
        : (language === 'en-US' ? 'No send date scheduled yet' : 'Ainda não há data de envio agendada');

      const blockers: string[] = [];
      if (warningSet.has('DESTINATION_EMAIL_MISSING')) {
        blockers.push(language === 'en-US'
          ? 'Add the destination email for your accountant.'
          : 'Defina o e-mail de destino do seu contabilista.');
      }
      if (warningSet.has('NO_MAIL_PROVIDER_CONNECTED')) {
        blockers.push(language === 'en-US'
          ? 'Connect Gmail or Outlook so Nexus can scan the source invoices.'
          : 'Ligue o Gmail ou o Outlook para o Nexus analisar as faturas de origem.');
      }
      if (warningSet.has('BUNDLE_DELIVERY_NOT_CONFIGURED')) {
        blockers.push(language === 'en-US'
          ? 'Bundle delivery is not configured on this server yet.'
          : 'O envio do bundle ainda não está configurado neste servidor.');
      }

      const headline = summary.warnings.length === 0
        ? (language === 'en-US'
          ? 'Your accountant handoff is ready.'
          : 'A entrega ao contabilista está pronta.')
        : (language === 'en-US'
          ? 'Your accountant handoff still needs a couple of pieces.'
          : 'A entrega ao contabilista ainda precisa de alguns ajustes.');

      const providerLine = connectedProviders.length > 0
        ? connectedProviders.join(', ')
        : (language === 'en-US' ? 'None connected yet' : 'Ainda sem fornecedores ligados');

      const blockerText = blockers.length > 0
        ? `\n\n${blockers.slice(0, 3).map((line) => `• ${line}`).join('\n')}`
        : '';

      return {
        text: language === 'en-US'
          ? `${headline}\n\n• Destination: ${destinationLine}\n• Cadence: ${cadenceLine}\n• Mail sources connected: ${providerLine}\n• Vendor rules tracked: ${summary.ruleCount}\n• Last bundle sent: ${lastBundleLine}\n• Next scheduled send: ${nextRunLine}${blockerText}`
          : `${headline}\n\n• Destino: ${destinationLine}\n• Cadência: ${cadenceLine}\n• Fontes de e-mail ligadas: ${providerLine}\n• Regras de fornecedores acompanhadas: ${summary.ruleCount}\n• Último bundle enviado: ${lastBundleLine}\n• Próximo envio agendado: ${nextRunLine}${blockerText}`,
        metadata: {
          type: 'finance_accountant_bundle_snapshot',
          destinationEmail: summary.destinationEmail,
          cadence: summary.profile.cadence,
          connectedProviders,
          ruleCount: summary.ruleCount,
          customRuleCount: summary.customRuleCount,
          warnings: summary.warnings,
          nextRunAt: summary.nextRunAt,
          lastBundleSentAt: summary.profile.last_bundle_sent_at,
          lastBundleDocumentCount: summary.profile.last_bundle_document_count,
          deliveryAvailable: summary.deliveryAvailable,
        },
      };
    }
    case 'monthly_spend': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const summary = getMonthlySummary(userId, month, financeScope);
      const budgetView = getMonthlyBudgetView(userId, month, financeScope);
      const recurringLine = budgetView.recurringExpenseEstimate > 0
        ? (language === 'en-US'
          ? `\n• Still likely in recurring commitments this month: ${formatCurrencyAmount(budgetView.basisCurrency, budgetView.recurringExpenseEstimate)}`
          : `\n• Ainda provável em compromissos recorrentes este mês: ${formatCurrencyAmount(budgetView.basisCurrency, budgetView.recurringExpenseEstimate)}`)
        : '';
      const mixedCurrencyLine = budgetView.integrity === 'mixed_currency'
        ? (language === 'en-US'
          ? `\n• Warning: mixed currencies (${budgetView.currencies.join(', ')}) make month-level budget comparisons provisional`
          : `\n• Aviso: moedas misturadas (${budgetView.currencies.join(', ')}) tornam as comparações mensais de orçamento provisórias`)
        : '';
      return {
        text: language === 'en-US'
          ? `This is your logged spending for ${monthLabel}.\n\n• Total spending: ${formatViews(summary.totalExpenses, language)}\n• Logged transactions: ${summary.transactionCount}${recurringLine}${mixedCurrencyLine}`
          : `Esta é a tua despesa registada em ${monthLabel}.\n\n• Gasto total: ${formatViews(summary.totalExpenses, language)}\n• Transações registadas: ${summary.transactionCount}${recurringLine}${mixedCurrencyLine}`,
        metadata: {
          type: 'finance_monthly_spend_snapshot',
          month,
          totalExpenses: summary.totalExpenses,
          transactionCount: summary.transactionCount,
          integrity: budgetView.integrity,
          basisCurrency: budgetView.basisCurrency,
          recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
          recurringExpenseCount: budgetView.recurringExpenseCount,
        },
      };
    }
    case 'filed_invoices': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const filings = getFilingsForMonth(now.year, now.month, userId).filter((filing) => filing.status === 'filed');
      if (filings.length === 0) {
        return {
          text: language === 'en-US'
            ? `I do not see any filed invoices for ${monthLabel} yet.`
            : `Ainda não vejo nenhuma fatura registada em ${monthLabel}.`,
          metadata: {
            type: 'finance_filed_invoices_snapshot',
            month,
            filedCount: 0,
            vendors: [],
          },
        };
      }

      const vendors = [...new Set(filings.map((filing) => filing.vendor.trim()).filter(Boolean))];
      const preview = vendors.slice(0, 5).map((vendor) => `• ${vendor}`).join('\n');
      const remainder = vendors.length > 5
        ? (language === 'en-US'
          ? `\n• +${vendors.length - 5} more vendors`
          : `\n• +${vendors.length - 5} fornecedores`)
        : '';

      return {
        text: language === 'en-US'
          ? `These invoices are already filed for ${monthLabel}:\n\n${preview}${remainder}\n\n• Filed documents: ${filings.length}`
          : `Estas faturas já estão registadas em ${monthLabel}:\n\n${preview}${remainder}\n\n• Documentos registados: ${filings.length}`,
        metadata: {
          type: 'finance_filed_invoices_snapshot',
          month,
          filedCount: filings.length,
          vendors,
        },
      };
    }
  }
}
