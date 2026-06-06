// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface SecretaryTodayCopy {
  title: string;
  decisionCenterCheckedLabel: string;
  decisionCenterCheckedDetail: string;
  handledByNexus: string;
  needsYou: string;
  waitingOnSource: string;
  summaryNeedsUser: (count: number) => string;
  summaryHandled: (count: number) => string;
  summaryWaitingOnSource: string;
  summaryAllClear: string;
}

export function secretaryTodayLabels(language?: string | null): SecretaryTodayCopy {
  const locale = normalizeSecretaryTodayLanguage(language);
  return {
    title: secretaryTodayText(locale, 'Secretary hoje', 'Secretary hoje', 'Secretary today'),
    decisionCenterCheckedLabel: secretaryTodayText(
      locale,
      'Centro de Decisões verificado',
      'Centro de Decisões verificado',
      'Decision Center checked',
    ),
    decisionCenterCheckedDetail: secretaryTodayText(
      locale,
      'Nexus atualizou a fila operacional de decisões a partir da verdade do backend.',
      'Nexus atualizou a fila operacional de decisões a partir da verdade do backend.',
      'Nexus refreshed the operational decision queue from backend source truth.',
    ),
    handledByNexus: secretaryTodayText(locale, 'Tratado pelo Nexus', 'Tratado pelo Nexus', 'Handled by Nexus'),
    needsYou: secretaryTodayText(locale, 'Precisa de ti', 'Precisa de você', 'Needs you'),
    waitingOnSource: secretaryTodayText(locale, 'A aguardar fonte', 'Aguardando fonte', 'Waiting on source'),
    summaryNeedsUser: (count) => secretaryTodayText(
      locale,
      `${count} decisão(ões) da Secretary precisam do teu julgamento.`,
      `${count} decisão(ões) da Secretary precisam do seu julgamento.`,
      `${count} Secretary decision(s) need your judgment.`,
    ),
    summaryHandled: (count) => secretaryTodayText(
      locale,
      `Nexus tratou ${count} item(s) da Secretary hoje.`,
      `Nexus tratou ${count} item(s) da Secretary hoje.`,
      `Nexus handled ${count} Secretary item(s) today.`,
    ),
    summaryWaitingOnSource: secretaryTodayText(
      locale,
      'A Secretary está a aguardar o estado da fonte antes de fechar o ciclo.',
      'A Secretary está aguardando o estado da fonte antes de fechar o ciclo.',
      'Secretary is waiting on source state before closing the loop.',
    ),
    summaryAllClear: secretaryTodayText(
      locale,
      'A Secretary verificou a fila de decisões; nada urgente precisa da tua ação agora.',
      'A Secretary verificou a fila de decisões; nada urgente precisa da sua ação agora.',
      'Secretary checked the decision queue; nothing urgent needs you right now.',
    ),
  };
}

export function secretaryTodayText(language: string | undefined | null, ptPt: string, ptBr: string, en: string): string {
  const locale = normalizeSecretaryTodayLanguage(language);
  if (locale.startsWith('pt-br')) return ptBr;
  if (locale.startsWith('pt')) return ptPt;
  return en;
}

function normalizeSecretaryTodayLanguage(language?: string | null): string {
  if (typeof language !== 'string' || language.trim().length === 0) return 'en';
  return language.trim().toLowerCase();
}
