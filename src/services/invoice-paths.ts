// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DateTime } from 'luxon';

// Keep filesystem naming independent from provider clients so storage,
// retention, and account-erasure tools can load without initializing AI SDKs.
export const PT_MONTHS: Readonly<Record<number, string>> = Object.freeze({
  1: 'Jan', 2: 'Fev', 3: 'Mar', 4: 'Abr', 5: 'Mai', 6: 'Jun',
  7: 'Jul', 8: 'Ago', 9: 'Set', 10: 'Out', 11: 'Nov', 12: 'Dez',
});

/** Returns Portuguese month folder name, e.g. "Mar-2026". */
export function getPortugueseMonthFolder(date: Pick<DateTime, 'month' | 'year'>): string {
  return `${PT_MONTHS[date.month]}-${date.year}`;
}
