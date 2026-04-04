// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WearableAdapter — interface that every provider adapter must implement.
 *
 * Each adapter wraps a single wearable API and normalizes its data
 * into the shared types defined in types.ts.
 */

import type {
  WearableProvider,
  ProviderCapabilities,
  NormalizedActivity,
  NormalizedSleep,
  NormalizedReadiness,
  NormalizedDailySummary,
} from './types';

export interface WearableAdapter {
  /** Which provider this adapter wraps. */
  readonly provider: WearableProvider;

  /** What data this provider can supply. */
  readonly capabilities: ProviderCapabilities;

  /** Check if this provider is configured/connected for the given user. */
  isConfigured(userId: number): Promise<boolean>;

  /** Fetch activities in the given date range (inclusive). */
  getActivities(userId: number, startDate: string, endDate: string): Promise<NormalizedActivity[]>;

  /** Fetch sleep data for a single date. Returns null if unsupported. */
  getSleep(userId: number, date: string): Promise<NormalizedSleep | null>;

  /** Fetch readiness/recovery data for a single date. Returns null if unsupported. */
  getReadiness(userId: number, date: string): Promise<NormalizedReadiness | null>;

  /** Fetch daily wellness summary for a single date. Returns null if unsupported. */
  getDailySummary(userId: number, date: string): Promise<NormalizedDailySummary | null>;
}
