// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateExecutiveBriefCaches } from './coordination-cache-invalidator';

/**
 * Finance writes change the Home executive brief and planning surfaces, but do
 * not currently change the dashboard root metrics family.
 */
export function invalidateFinanceDerivedCaches(userId?: number): void {
  invalidateExecutiveBriefCaches(userId);
}
