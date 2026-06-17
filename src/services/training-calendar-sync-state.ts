// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type CalendarSyncState =
  | 'not_requested'
  | 'pending'
  | 'synced'
  | 'verified'
  | 'stale'
  | 'repair_needed'
  | 'provider_disconnected'
  | 'failed'
  | 'unscheduled';

export interface CalendarSyncDisplayInput {
  hasStoredCalendarEventId: boolean;
  verifiedCalendarEventId?: string | null;
  providerDisconnected?: boolean;
  syncFailed?: boolean;
  syncPending?: boolean;
  manualUnscheduled?: boolean;
}

export interface CalendarEventOwnership {
  provider: 'google' | 'outlook' | 'apple';
  calendarId: string;
  providerEventId: string;
  sessionId: string;
  planId: string;
  lastVerifiedAt: string;
  syncVersion: string;
}

export function resolveCalendarSyncState(input: CalendarSyncDisplayInput): CalendarSyncState {
  if (input.providerDisconnected) return 'provider_disconnected';
  if (input.syncFailed) return 'failed';
  if (input.syncPending) return 'pending';
  if (input.verifiedCalendarEventId) return 'verified';
  if (input.hasStoredCalendarEventId) return 'repair_needed';
  if (input.manualUnscheduled) return 'unscheduled';
  return 'not_requested';
}

export function calendarSyncStateIsLinked(state: unknown): boolean {
  const normalized = String(state || '').trim().toLowerCase();
  return normalized === 'synced' || normalized === 'verified';
}

export function calendarSyncStateNeedsRepair(state: unknown): boolean {
  const normalized = String(state || '').trim().toLowerCase();
  return normalized === 'stale' || normalized === 'repair_needed';
}
