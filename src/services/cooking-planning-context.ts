// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { getMonthlyBudgetView } from './finance-tracker';
import { listSecretaryAgendaItems } from './secretary-scheduling-arbitrator';

export interface CookingFinanceBudgetContext {
  source: 'finance_monthly_budget';
  status: 'available' | 'unavailable';
  integrity: string | null;
  affordability: string | null;
  budgetLimit: number | null;
  currency: string | null;
  monthKeys: string[];
  notes: string[];
}

export interface CookingSecretaryAvailabilityContext {
  source: 'secretary_agenda_items';
  status: 'available' | 'unknown';
  defaultCookingWindow: {
    startHour: number;
    endHour: number;
    timezone: string;
  };
  availableCookingMinutesByDate: Record<string, number>;
  busyAgendaItemIdsByDate: Record<string, string[]>;
  notes: string[];
}

interface DateRangeInput {
  userId: number;
  tenantId: number;
  from: string;
  to: string;
  timezone?: string | null;
}

const DEFAULT_COOKING_WINDOW_START_HOUR = 17;
const DEFAULT_COOKING_WINDOW_END_HOUR = 21;

export function buildCookingFinanceBudgetContext(input: DateRangeInput): CookingFinanceBudgetContext {
  const dates = enumerateIsoDates(input.from, input.to, input.timezone);
  if (dates.length === 0) {
    return unavailableFinanceContext(['Invalid date range for Finance budget context.']);
  }

  const monthKeys = uniqueStrings(dates.map((date) => date.slice(0, 7)));
  const notes: string[] = [];
  let currency: string | null = null;
  let budgetLimit = 0;
  let usableMonths = 0;
  let tightSeen = false;
  const integrities = new Set<string>();
  const affordability = new Set<string>();

  for (const month of monthKeys) {
    const view = getMonthlyBudgetView(input.userId, month);
    integrities.add(view.integrity);
    affordability.add(view.affordability);
    notes.push(...view.notes);

    if (view.integrity !== 'reliable' || view.projectedRemainingInBasisCurrency == null) {
      continue;
    }
    if (currency && currency !== view.basisCurrency) {
      notes.push(`Finance budget spans multiple currencies (${currency}, ${view.basisCurrency}); Cooking will not infer a combined grocery budget.`);
      return unavailableFinanceContext(notes, monthKeys);
    }

    currency = view.basisCurrency;
    if (view.affordability === 'tight') tightSeen = true;
    const monthDates = dates.filter((date) => date.startsWith(month));
    budgetLimit += prorateMonthlyRemaining(view.projectedRemainingInBasisCurrency, monthDates.length, month);
    usableMonths += 1;
  }

  if (usableMonths === 0) {
    return {
      source: 'finance_monthly_budget',
      status: 'unavailable',
      integrity: integrities.size ? [...integrities].join(',') : null,
      affordability: affordability.size ? [...affordability].join(',') : null,
      budgetLimit: null,
      currency,
      monthKeys,
      notes: uniqueStrings(notes.length ? notes : ['Finance budget context is unavailable for this range.']),
    };
  }

  return {
    source: 'finance_monthly_budget',
    status: 'available',
    integrity: integrities.size ? [...integrities].join(',') : 'reliable',
    affordability: tightSeen ? 'tight' : affordability.size ? [...affordability].join(',') : null,
    budgetLimit: roundMoney(budgetLimit),
    currency,
    monthKeys,
    notes: uniqueStrings(notes),
  };
}

export function buildCookingSecretaryAvailabilityContext(input: DateRangeInput): CookingSecretaryAvailabilityContext {
  const timezone = input.timezone || config.app.timezone || 'Europe/Lisbon';
  const dates = enumerateIsoDates(input.from, input.to, timezone);
  const busyAgendaItemIdsByDate: Record<string, string[]> = {};
  const availableCookingMinutesByDate: Record<string, number> = {};
  if (dates.length === 0) {
    return {
      source: 'secretary_agenda_items',
      status: 'unknown',
      defaultCookingWindow: {
        startHour: DEFAULT_COOKING_WINDOW_START_HOUR,
        endHour: DEFAULT_COOKING_WINDOW_END_HOUR,
        timezone,
      },
      availableCookingMinutesByDate,
      busyAgendaItemIdsByDate,
      notes: ['Invalid date range for Secretary availability context.'],
    };
  }

  const agendaItems = listSecretaryAgendaItems({
    ownerUserId: input.userId,
    tenantId: input.tenantId,
  }).filter((item) => item.startAt && item.endAt);

  for (const date of dates) {
    const windowStart = DateTime.fromISO(date, { zone: timezone }).set({
      hour: DEFAULT_COOKING_WINDOW_START_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    const windowEnd = DateTime.fromISO(date, { zone: timezone }).set({
      hour: DEFAULT_COOKING_WINDOW_END_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    const totalWindowMinutes = Math.max(0, windowEnd.diff(windowStart, 'minutes').minutes);
    let busyMinutes = 0;
    const busyIds: string[] = [];

    for (const item of agendaItems) {
      const busyStart = DateTime.fromISO(item.startAt!, { setZone: true }).setZone(timezone);
      const busyEnd = DateTime.fromISO(item.endAt!, { setZone: true }).setZone(timezone);
      const overlap = overlapMinutes(windowStart, windowEnd, busyStart, busyEnd);
      if (overlap <= 0) continue;
      busyMinutes += overlap;
      busyIds.push(item.agendaItemId);
    }

    if (busyIds.length > 0) {
      availableCookingMinutesByDate[date] = Math.max(0, Math.round(totalWindowMinutes - busyMinutes));
      busyAgendaItemIdsByDate[date] = busyIds;
    }
  }

  return {
    source: 'secretary_agenda_items',
    status: Object.keys(availableCookingMinutesByDate).length > 0 ? 'available' : 'unknown',
    defaultCookingWindow: {
      startHour: DEFAULT_COOKING_WINDOW_START_HOUR,
      endHour: DEFAULT_COOKING_WINDOW_END_HOUR,
      timezone,
    },
    availableCookingMinutesByDate,
    busyAgendaItemIdsByDate,
    notes: Object.keys(availableCookingMinutesByDate).length > 0
      ? ['Secretary agenda was used to estimate cooking-window pressure.']
      : ['No Secretary agenda pressure found in the default cooking window.'],
  };
}

function unavailableFinanceContext(notes: string[], monthKeys: string[] = []): CookingFinanceBudgetContext {
  return {
    source: 'finance_monthly_budget',
    status: 'unavailable',
    integrity: null,
    affordability: null,
    budgetLimit: null,
    currency: null,
    monthKeys,
    notes: uniqueStrings(notes),
  };
}

function enumerateIsoDates(from: string, to: string, timezone?: string | null): string[] {
  const zone = timezone || config.app.timezone || 'Europe/Lisbon';
  const start = DateTime.fromISO(from, { zone }).startOf('day');
  const end = DateTime.fromISO(to, { zone }).startOf('day');
  if (!start.isValid || !end.isValid || end < start) return [];
  const result: string[] = [];
  for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
    const iso = cursor.toISODate();
    if (iso) result.push(iso);
  }
  return result;
}

function prorateMonthlyRemaining(projectedRemaining: number, plannedDaysInMonth: number, month: string): number {
  const monthStart = DateTime.fromISO(`${month}-01`);
  const daysInMonth = monthStart.daysInMonth || 30;
  return projectedRemaining * (plannedDaysInMonth / daysInMonth);
}

function overlapMinutes(
  leftStart: DateTime,
  leftEnd: DateTime,
  rightStart: DateTime,
  rightEnd: DateTime,
): number {
  const start = Math.max(leftStart.toMillis(), rightStart.toMillis());
  const end = Math.min(leftEnd.toMillis(), rightEnd.toMillis());
  return Math.max(0, Math.round((end - start) / 60000));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
