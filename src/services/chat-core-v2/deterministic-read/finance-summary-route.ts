// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getMonthlyBudgetView,
  getMonthlySummary,
  type MonthlyBudgetView,
  type MonthlySummary,
} from '../../finance-tracker';
import {
  buildFinanceStateShortcutResponse,
} from '../../../api/routes/chat-state-shortcuts';
import {
  parseFinanceStateShortcut,
  resolveFinanceShortcutLanguage,
} from '../../../api/routes/chat-shortcut-parsers';
import { evaluateChatCoreV2FinanceActionPolicy } from '../finance-action-policy';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  FINANCE_SUMMARY_CAPABILITY,
  hashStable,
  normalizeTimezone,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2FinanceSummaryData,
} from './types';

export function buildFinanceSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const month = currentMonthKey(now, normalizeTimezone(input.timezone));
  const policy = evaluateChatCoreV2FinanceActionPolicy({
    actionClass: 'finance.read_summary',
    operation: 'read',
    usesAggregateContextOnly: true,
    includesRawTransactionRows: false,
    includesRawTaxOrPaymentDetails: false,
  });
  if (!policy.ok) return null;

  const summary = getMonthlySummary(input.userId, month, { tenantId: input.tenantId });
  const budget = getMonthlyBudgetView(input.userId, month, { tenantId: input.tenantId });
  const data = buildFinanceSummaryData(summary, budget);
  const shortcut = parseFinanceStateShortcut(input.normalizedText);
  const shortcutSummary = shortcut
    ? buildFinanceStateShortcutResponse(
      shortcut,
      input.userId,
      resolveFinanceShortcutLanguage(input.locale),
      input.tenantId,
    )
    : null;
  const sourceEntityIds = [financeSummaryEntityId(month)];
  if (shortcut) sourceEntityIds.push(financeShortcutEntityId(shortcut));
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2FinanceSummaryData>({
    capabilityId: FINANCE_SUMMARY_CAPABILITY,
    domain: 'finance',
    data,
    sourceEntityIds,
    sourceVersions: sourceVersionsForFinance(data, shortcut, shortcutSummary?.metadata ?? null),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'financial',
    summary: shortcutSummary?.text ?? buildFinanceSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? shortcutSummary?.text ?? buildFinanceSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: [
      'deterministic_read',
      FINANCE_SUMMARY_CAPABILITY,
      ...policy.reasons,
      ...(shortcut ? [`finance_shortcut:${shortcut}`] : []),
    ],
  });

  return {
    capabilityId: FINANCE_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function buildFinanceSummaryData(
  summary: MonthlySummary,
  budget: MonthlyBudgetView,
): ChatCoreV2FinanceSummaryData {
  return {
    month: summary.month,
    basisCurrency: budget.basisCurrency,
    currencies: [...budget.currencies].sort(),
    totalIncome: roundMoney(summary.totalIncome),
    totalExpenses: roundMoney(summary.totalExpenses),
    totalDeductions: roundMoney(summary.totalDeductions),
    netIncome: roundMoney(summary.netIncome),
    transactionCount: summary.transactionCount,
    integrity: budget.integrity,
    affordability: budget.affordability,
    currentRemaining: nullableRoundMoney(budget.currentRemainingInBasisCurrency),
    projectedRemaining: nullableRoundMoney(budget.projectedRemainingInBasisCurrency),
    recurringExpenseEstimate: roundMoney(budget.recurringExpenseEstimate),
    recurringExpenseCount: budget.recurringExpenseCount,
    notes: budget.notes.slice(0, 3),
  };
}

function buildFinanceSummaryText(data: ChatCoreV2FinanceSummaryData, locale: string | null | undefined): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.transactionCount === 0) {
    if (normalizedLocale === 'pt-BR') return `Ainda não há movimentos financeiros registados para ${data.month}.`;
    if (normalizedLocale === 'pt-PT') return `Ainda não há movimentos financeiros registados para ${data.month}.`;
    return `No finance transactions are logged for ${data.month} yet.`;
  }

  const header = buildFinanceSummaryHeader(data, normalizedLocale);
  const details = buildFinanceSummaryDetails(data, normalizedLocale);
  return details.length > 0 ? `${header}\n\n${details.map((line) => `- ${line}`).join('\n')}` : header;
}

function buildFinanceSummaryHeader(
  data: ChatCoreV2FinanceSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts = [
    moneyPhrase(data.basisCurrency, data.totalIncome, locale, 'income'),
    moneyPhrase(data.basisCurrency, data.totalExpenses, locale, 'expenses'),
    moneyPhrase(data.basisCurrency, data.netIncome, locale, 'net'),
  ];
  const joined = joinParts(parts, locale);
  const transactions = transactionPhrase(data.transactionCount, locale);

  if (locale === 'pt-BR') return `Resumo financeiro de ${data.month}: ${joined}, em ${transactions}.`;
  if (locale === 'pt-PT') return `Resumo financeiro de ${data.month}: ${joined}, em ${transactions}.`;
  return `Finance summary for ${data.month}: ${joined}, across ${transactions}.`;
}

function transactionPhrase(count: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `${count} ${plural(count, 'movimento', 'movimentos')}`;
  return `${count} ${plural(count, 'transaction', 'transactions')}`;
}

function buildFinanceSummaryDetails(
  data: ChatCoreV2FinanceSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string[] {
  const lines: string[] = [];
  if (data.currentRemaining != null) {
    lines.push(detailPhrase(locale, 'current', formatMoney(data.basisCurrency, data.currentRemaining)));
  }
  if (data.projectedRemaining != null && data.projectedRemaining !== data.currentRemaining) {
    lines.push(detailPhrase(locale, 'projected', formatMoney(data.basisCurrency, data.projectedRemaining)));
  }
  if (data.recurringExpenseCount > 0) {
    lines.push(detailPhrase(locale, 'recurring', `${formatMoney(data.basisCurrency, data.recurringExpenseEstimate)} / ${data.recurringExpenseCount}`));
  }
  if (data.affordability !== 'unknown') {
    lines.push(detailPhrase(locale, 'affordability', data.affordability));
  }
  if (data.integrity !== 'reliable') {
    lines.push(detailPhrase(locale, 'integrity', data.integrity));
  }
  return lines;
}

function moneyPhrase(
  currency: string,
  amount: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'income' | 'expenses' | 'net',
): string {
  const value = formatMoney(currency, amount);
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'income') return `${value} de entradas`;
    if (kind === 'expenses') return `${value} de gastos`;
    return `${value} líquidos`;
  }
  if (kind === 'income') return `${value} income`;
  if (kind === 'expenses') return `${value} expenses`;
  return `${value} net`;
}

function detailPhrase(
  locale: ChatCoreV2NormalizedLocale,
  kind: 'current' | 'projected' | 'recurring' | 'affordability' | 'integrity',
  value: string,
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'current') return `Disponível agora: ${value}`;
    if (kind === 'projected') return `Disponível projetado: ${value}`;
    if (kind === 'recurring') return `Compromissos recorrentes ainda prováveis: ${value}`;
    if (kind === 'affordability') return `Modo de orçamento: ${value}`;
    return `Fiabilidade: ${value}`;
  }
  if (kind === 'current') return `Current headroom: ${value}`;
  if (kind === 'projected') return `Projected headroom: ${value}`;
  if (kind === 'recurring') return `Likely recurring commitments still ahead: ${value}`;
  if (kind === 'affordability') return `Budget mode: ${value}`;
  return `Reliability: ${value}`;
}

function currentMonthKey(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    return year && month ? `${year}-${month}` : now.toISOString().slice(0, 7);
  } catch {
    return now.toISOString().slice(0, 7);
  }
}

function financeSummaryEntityId(month: string): string {
  return `finance:summary:${month}`;
}

function financeShortcutEntityId(shortcut: string): string {
  return `finance_shortcut:${shortcut}`;
}

function sourceVersionsForFinance(
  data: ChatCoreV2FinanceSummaryData,
  shortcut: string | null,
  shortcutMetadata: Record<string, unknown> | null,
): Record<string, string> {
  const versions: Record<string, string> = {
    [financeSummaryEntityId(data.month)]: hashStable(data),
  };
  if (shortcut) {
    versions[financeShortcutEntityId(shortcut)] = hashStable({
      shortcut,
      metadata: shortcutMetadata,
    });
  }
  return versions;
}

function formatMoney(currency: string, amount: number): string {
  return `${currency.toUpperCase()} ${roundMoney(amount).toFixed(2)}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nullableRoundMoney(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? roundMoney(value) : null;
}
