// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  validateTrainingM4CapacityWindowShapes,
  type TrainingM4CapacityWindow,
} from './training-m4-plan-strategies';

export interface TrainingM4AuthoritativeCapacityContext {
  source: 'AUTHORITATIVE';
  contextVersion: string;
  windows: TrainingM4CapacityWindow[];
  observedAt: string;
  expiresAt: string;
}

export type TrainingM4CapacityContextProvider = (scope: {
  userId: number;
  tenantId: number;
}) => TrainingM4AuthoritativeCapacityContext | null;

let provider: TrainingM4CapacityContextProvider | null = null;

/** Composition seam for an authoritative calendar/profile capacity service.
 * No provider is registered by default, so production fails closed to the
 * explicit-user path instead of inventing calendar freshness. */
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
  if (!provider || scope.userId !== scope.tenantId) return null;
  let context: TrainingM4AuthoritativeCapacityContext | null;
  try {
    context = provider(scope);
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
      || Date.parse(context.expiresAt) <= now.getTime()) return null;
  return {
    ...context,
    windows: context.windows.map((window) => ({
      ...window,
      ...(window.allowedDisciplines ? { allowedDisciplines: [...window.allowedDisciplines] } : {}),
    })),
  };
}

function validCapacityWindows(windows: TrainingM4CapacityWindow[]): boolean {
  try {
    validateTrainingM4CapacityWindowShapes(windows);
    return true;
  } catch {
    return false;
  }
}
