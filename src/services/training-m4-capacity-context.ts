// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  trainingM4PlanEndDate,
  validateTrainingM4CapacityWindowShapes,
  type TrainingM4CapacityWindow,
} from './training-m4-plan-strategies';
import type { CalendarSource } from './unified-calendar';
import { readMaterializedTrainingM4CapacityContext } from './training-m4-capacity-snapshots';

export interface TrainingM4AuthoritativeCapacityContext {
  source: 'AUTHORITATIVE';
  contextVersion: string;
  windows: TrainingM4CapacityWindow[];
  observedAt: string;
  expiresAt: string;
  profileSourceVersion: string;
  calendarEventSetHash: string;
  calendarSources: CalendarSource[];
  planStartDate: string;
  planEndDate: string;
  horizonWeeks: number;
  conflictCount: number;
}

export type TrainingM4CapacityContextProvider = (scope: {
  userId: number;
  tenantId: number;
}) => TrainingM4AuthoritativeCapacityContext | null;

let provider: TrainingM4CapacityContextProvider | null = null;

/** Test/composition override for an authoritative calendar/profile service.
 * Production defaults to the persisted, provider-refreshed snapshot reader. */
export function registerTrainingM4CapacityContextProvider(
  next: TrainingM4CapacityContextProvider,
): () => void {
  if (provider) throw new Error('TRAINING_M4_CAPACITY_PROVIDER_ALREADY_REGISTERED');
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

export function getTrainingM4AuthoritativeCapacityContext(
  scope: { userId: number; tenantId: number },
  now = new Date(),
): TrainingM4AuthoritativeCapacityContext | null {
  if (scope.userId !== scope.tenantId) return null;
  let context: TrainingM4AuthoritativeCapacityContext | null;
  try {
    context = provider
      ? provider(scope)
      : readMaterializedTrainingM4CapacityContext({ scope, now });
  } catch {
    return null;
  }
  if (!context
      || context.source !== 'AUTHORITATIVE'
      || !/^[0-9A-Za-z_.:-]{1,200}$/.test(context.contextVersion)
      || !Array.isArray(context.windows)
      || !validCapacityWindows(context.windows)
      || !Number.isFinite(Date.parse(context.observedAt))
      || !Number.isFinite(Date.parse(context.expiresAt))
      || Date.parse(context.observedAt) > now.getTime()
      || Date.parse(context.observedAt) >= Date.parse(context.expiresAt)
      || Date.parse(context.expiresAt) <= now.getTime()
      || !/^m4profile_[a-f0-9]{64}$/.test(context.profileSourceVersion)
      || !/^[a-f0-9]{64}$/.test(context.calendarEventSetHash)
      || !Array.isArray(context.calendarSources)
      || context.calendarSources.length === 0
      || context.calendarSources.some((source) => source !== 'google' && source !== 'outlook')
      || new Set(context.calendarSources).size !== context.calendarSources.length
      || !/^\d{4}-\d{2}-\d{2}$/.test(context.planStartDate)
      || !/^\d{4}-\d{2}-\d{2}$/.test(context.planEndDate)
      || !Number.isSafeInteger(context.horizonWeeks)
      || context.horizonWeeks < 1 || context.horizonWeeks > 52
      || !validCapacityRange(context)
      || !Number.isSafeInteger(context.conflictCount)
      || context.conflictCount < 0) return null;
  return {
    ...context,
    calendarSources: [...context.calendarSources],
    windows: context.windows.map((window) => ({
      ...window,
      ...(window.allowedDisciplines ? { allowedDisciplines: [...window.allowedDisciplines] } : {}),
    })),
  };
}

function validCapacityRange(context: TrainingM4AuthoritativeCapacityContext): boolean {
  try {
    return trainingM4PlanEndDate(context.planStartDate, context.horizonWeeks) === context.planEndDate;
  } catch {
    return false;
  }
}

function validCapacityWindows(windows: TrainingM4CapacityWindow[]): boolean {
  try {
    validateTrainingM4CapacityWindowShapes(windows);
    return true;
  } catch {
    return false;
  }
}
