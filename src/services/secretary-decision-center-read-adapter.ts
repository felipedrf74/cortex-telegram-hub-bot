// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDecisionOverview } from './decision-center';
import type { SecretaryTodayDecisionSignals } from './secretary-orchestrator';
import {
  degradedPlanSource,
  readyPlanSource,
  unavailablePlanSource,
  type PlanSourceHealth,
} from './secretary-planning-context';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export interface SecretaryDecisionReadProjection {
  signals?: SecretaryTodayDecisionSignals;
  health: PlanSourceHealth;
}

/**
 * Narrow, read-only Decision Center projection for Secretary daily planning.
 * It exposes no Decision mutation, approval, receipt, or execution surface.
 */
export function readSecretaryDecisionProjection(
  userId: number,
  tenantId: number,
): SecretaryDecisionReadProjection {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId) || userId !== tenantId) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'read_secretary_decision_projection',
      reason: userId === tenantId ? 'invalid_user_scope' : 'tenant_mismatch',
      userId,
      details: { tenantId },
    });
    return {
      health: unavailablePlanSource(
        'DECISION_CENTER_SCOPE_INVALID',
        'Decision Center state is unavailable for the active account scope.',
      ),
    };
  }
  try {
    const overview = getDecisionOverview(userId, tenantId, { limit: 30, handledLimit: 10 });
    const secretaryOpen = overview.items.filter((item) => item.sourceSkill === 'secretary');
    const secretaryHandled = overview.handled.filter((item) => item.sourceSkill === 'secretary');
    const itemsAvailable = overview.partial.items;
    const handledAvailable = overview.partial.handled;
    const health = itemsAvailable && handledAvailable
      ? readyPlanSource()
      : itemsAvailable || handledAvailable
        ? degradedPlanSource(
          'DECISION_CENTER_PARTIAL',
          'Decision Center returned only part of its current state.',
        )
        : unavailablePlanSource(
          'DECISION_CENTER_UNAVAILABLE',
          'Decision Center state is unavailable.',
        );

    return {
      signals: {
        handledCount: secretaryHandled.length,
        handledTitles: secretaryHandled
          .map((item) => item.explanation?.result ?? item.summary ?? item.title)
          .filter((value): value is string => Boolean(value && value.trim().length > 0))
          .slice(0, 3),
        needsUserCount: secretaryOpen.length,
        needsUserTitles: secretaryOpen
          .map((item) => item.explanation?.userAction ?? item.summary ?? item.title)
          .filter((value): value is string => Boolean(value && value.trim().length > 0))
          .slice(0, 3),
        staleCount: secretaryOpen.filter((item) => (
          item.analysis.sourceFreshness === 'stale'
          || item.sourceTrace?.dataFreshness === 'cached'
        )).length,
        topUserAction: secretaryOpen[0]?.explanation?.userAction
          ?? secretaryOpen[0]?.recommendedActionLabel
          ?? null,
      },
      health,
    };
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error, userId, tenantId },
      'Secretary Decision Center read projection unavailable',
    );
    return {
      health: unavailablePlanSource(
        'DECISION_CENTER_UNAVAILABLE',
        'Decision Center state is unavailable.',
      ),
    };
  }
}
