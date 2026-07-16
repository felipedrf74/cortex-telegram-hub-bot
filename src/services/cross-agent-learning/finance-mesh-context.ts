// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Finance mesh adapter. */

import { DateTime } from 'luxon';
import {
  getAnnualTaxSummary,
  getMonthlyBudgetView,
  getMonthlySummary,
  getPreferredCurrencyForUser,
  getTaxEvents,
} from '../finance-tracker';
import { getSubscriptionStatus } from '../stripe-service';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type { FinanceMeshContext, MeshSignalDraft } from './types';
import { endOfDayIso, reportInvalidMeshScope, resolveWeekWindow, roundTo, safely } from './mesh-common';

export function createEmptyFinanceMeshContext(opts: { userId: number; tenantId?: number; weekStart?: string }): FinanceMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  const month = window.start.toFormat('yyyy-MM');
  const year = window.start.year;
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    month,
    monthlySummary: {
      month,
      currency: null,
      currencies: [],
      mixedCurrency: false,
      totalIncome: 0,
      totalExpenses: 0,
      totalDeductions: 0,
      netIncome: 0,
      transactionCount: 0,
    },
    budgetView: {
      month,
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'no_income',
      affordability: 'unknown',
      incomeInBasisCurrency: 0,
      expensesInBasisCurrency: 0,
      currentRemainingInBasisCurrency: null,
      currentRemainingRatio: null,
      projectedExpensesInBasisCurrency: null,
      projectedRemainingInBasisCurrency: null,
      projectedRemainingRatio: null,
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      recurringExpenses: [],
      notes: [],
    },
    taxEvents: [],
    annualSummary: {
      year,
      totalGrossIncome: 0,
      totalDeductions: 0,
      totalInssDue: 0,
      totalTaxDue: 0,
      totalPaid: 0,
      totalPending: 0,
      effectiveAnnualRate: 0,
      monthsPaid: 0,
      monthsPending: 0,
      months: [],
    },
    subscription: {
      plan: 'free',
      period: 'monthly',
      status: 'inactive',
      provider: 'none',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      isActive: false,
      isPro: false,
    },
    derivedSignals: [],
  };
}

export async function readFinanceMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
}): Promise<FinanceMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_finance_mesh_context', opts.userId, opts.weekStart);
    return createEmptyFinanceMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  const month = window.start.toFormat('yyyy-MM');
  const year = window.start.year;
  const monthlySummary = safely(() => getMonthlySummary(opts.userId, month, { tenantId: opts.tenantId }), {
    month,
    currency: null,
    currencies: [],
    mixedCurrency: false,
    totalIncome: 0,
    totalExpenses: 0,
    totalDeductions: 0,
    netIncome: 0,
    transactionCount: 0,
  });
  const preferredCurrency = getPreferredCurrencyForUser(opts.userId);
  const budgetView = safely(() => getMonthlyBudgetView(opts.userId, month, { tenantId: opts.tenantId }), {
    month,
    basisCurrency: preferredCurrency,
    currencies: [preferredCurrency],
    integrity: 'no_income' as const,
    affordability: 'unknown' as const,
    incomeInBasisCurrency: 0,
    expensesInBasisCurrency: 0,
    currentRemainingInBasisCurrency: null,
    currentRemainingRatio: null,
    projectedExpensesInBasisCurrency: null,
    projectedRemainingInBasisCurrency: null,
    projectedRemainingRatio: null,
    recurringExpenseEstimate: 0,
    recurringExpenseCount: 0,
    recurringExpenses: [],
    notes: [],
  });
  const taxEvents = safely(() => getTaxEvents(opts.userId, { year, limit: 24 }), []);
  const annualSummary = safely(() => getAnnualTaxSummary(opts.userId, year), {
    year,
    totalGrossIncome: 0,
    totalDeductions: 0,
    totalInssDue: 0,
    totalTaxDue: 0,
    totalPaid: 0,
    totalPending: 0,
    effectiveAnnualRate: 0,
    monthsPaid: 0,
    monthsPending: 0,
    months: [],
  });
  const subscription = safely(() => getSubscriptionStatus(opts.userId), {
    plan: 'free',
    period: 'monthly',
    status: 'inactive',
    provider: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isActive: false,
    isPro: false,
  });

  const remainingRatio = budgetView.projectedRemainingRatio ?? budgetView.currentRemainingRatio;
  const nearestPending = taxEvents.find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
  const renewalDueSoon = subscription.currentPeriodEnd
    ? DateTime.fromISO(subscription.currentPeriodEnd).diffNow('days').days <= 10
    : false;
  const budgetConstraints = remainingRatio != null
    ? deriveBudgetConstraints(remainingRatio, {
      renewalDueSoon,
      hasPendingTax: Boolean(nearestPending),
    })
    : null;
  const derivedSignals: MeshSignalDraft[] = [];

  if (budgetConstraints && remainingRatio != null) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      meshPriority: remainingRatio <= 0.25 ? 2 : 3,
      priority: remainingRatio <= 0.25 ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        remainingRatio: roundTo(remainingRatio, 2),
        currentRemainingRatio: budgetView.currentRemainingRatio,
        projectedRemainingRatio: budgetView.projectedRemainingRatio,
        totalIncome: monthlySummary.totalIncome,
        totalExpenses: monthlySummary.totalExpenses,
        totalDeductions: monthlySummary.totalDeductions,
        basisCurrency: budgetView.basisCurrency,
        integrity: budgetView.integrity,
        affordability: budgetView.affordability,
        recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
        recurringExpenseCount: budgetView.recurringExpenseCount,
        budgetMode: budgetConstraints.budgetMode,
        groceryMode: budgetConstraints.groceryMode,
        trainingSpendMode: budgetConstraints.trainingSpendMode,
        contentSpendMode: budgetConstraints.contentSpendMode,
        supplementMode: budgetConstraints.supplementMode,
        subscriptionMode: budgetConstraints.subscriptionMode,
      },
    });
  } else if (budgetView.integrity === 'mixed_currency') {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'expense_anomaly',
      meshPriority: 4,
      priority: 'background',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        reason: 'mixed_currency_budget',
        currencies: budgetView.currencies,
        notes: budgetView.notes,
      },
    });
  }

  if (nearestPending) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'tax_deadline',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month: nearestPending.month,
        amountDue: nearestPending.tax_due,
        reminderDate: taxReminderDate(nearestPending.month),
      },
    });
  }

  if (renewalDueSoon && subscription.currentPeriodEnd) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'subscription_renewal_due',
      meshPriority: 4,
      priority: 'background',
      expiresAt: subscription.currentPeriodEnd,
      payload: {
        plan: subscription.plan,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
    });
  }

  if (budgetView.integrity === 'reliable'
      && budgetView.incomeInBasisCurrency > 0
      && budgetView.projectedExpensesInBasisCurrency != null
      && budgetView.projectedExpensesInBasisCurrency > budgetView.incomeInBasisCurrency * 0.85) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'expense_anomaly',
      meshPriority: 4,
      priority: 'background',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        totalIncome: budgetView.incomeInBasisCurrency,
        totalExpenses: budgetView.projectedExpensesInBasisCurrency,
        ratio: roundTo(budgetView.projectedExpensesInBasisCurrency / budgetView.incomeInBasisCurrency, 2),
        basisCurrency: budgetView.basisCurrency,
      },
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    month,
    monthlySummary,
    budgetView,
    taxEvents,
    annualSummary,
    subscription,
    derivedSignals,
  };
}

function deriveBudgetConstraints(
  remainingRatio: number,
  opts: { renewalDueSoon: boolean; hasPendingTax: boolean },
): {
  budgetMode: 'tight' | 'controlled' | 'normal';
  groceryMode: 'essentials_only' | 'cost_aware' | 'normal';
  trainingSpendMode: 'maintenance_only' | 'selective' | 'normal';
  contentSpendMode: 'lean' | 'selective' | 'normal';
  supplementMode: 'essentials_only' | 'pause_new' | 'normal';
  subscriptionMode: 'review_now' | 'confirm_value' | 'stable';
} {
  if (remainingRatio <= 0.15) {
    return {
      budgetMode: 'tight',
      groceryMode: 'essentials_only',
      trainingSpendMode: 'maintenance_only',
      contentSpendMode: 'lean',
      supplementMode: 'essentials_only',
      subscriptionMode: opts.renewalDueSoon || opts.hasPendingTax ? 'review_now' : 'confirm_value',
    };
  }

  if (remainingRatio <= 0.3) {
    return {
      budgetMode: 'controlled',
      groceryMode: 'cost_aware',
      trainingSpendMode: 'selective',
      contentSpendMode: 'selective',
      supplementMode: 'pause_new',
      subscriptionMode: opts.renewalDueSoon ? 'review_now' : 'confirm_value',
    };
  }

  return {
    budgetMode: 'normal',
    groceryMode: 'normal',
    trainingSpendMode: 'normal',
    contentSpendMode: 'normal',
    supplementMode: 'normal',
    subscriptionMode: opts.renewalDueSoon ? 'confirm_value' : 'stable',
  };
}

function taxReminderDate(month: string): string {
  const parsed = DateTime.fromFormat(month, 'yyyy-MM', { zone: 'UTC' });
  if (!parsed.isValid) return `${month}-28`;
  return parsed.endOf('month').toISODate()!;
}
