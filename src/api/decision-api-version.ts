// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center API version negotiation (v1 default, v2 opt-in).
 *
 * v2 ships compact DecisionCardSummary items on list/overview surfaces (full item only on
 * detail), behind the DECISION_API_V2_ENABLED flag + an x-nexus-api-version: v2 request
 * header. v1 clients (no header / flag off) keep the existing full-item shape unchanged.
 */

import type { AuthenticatedRequest } from './auth-middleware';
import { isDecisionApiV2Enabled } from '../services/runtime-flags';
export {
  buildDecisionCardSummary,
  deriveEvidenceStrengthLabel,
  type DecisionCardActionSummary,
  type DecisionCardSummaryV2Extras,
} from '../services/decision-center/card-projection';

export type DecisionApiVersion = 'v1' | 'v2';

export interface ResolvedDecisionApiVersion {
  version: DecisionApiVersion;
  schemaVersion: 'decision-center.v1' | 'decision-center.v2';
}

export const DECISION_API_VERSION_HEADER = 'x-nexus-api-version';

function requestedVersionHeader(req: AuthenticatedRequest): string {
  const raw = (req.headers?.[DECISION_API_VERSION_HEADER] ?? '') as string | string[];
  const value = Array.isArray(raw) ? raw[0] ?? '' : raw;
  return value.trim().toLowerCase();
}

/** v2 only when the client asks for it AND the flag is opt-in for this user/tenant. */
export function resolveDecisionApiVersion(req: AuthenticatedRequest): ResolvedDecisionApiVersion {
  const wantsV2 = requestedVersionHeader(req) === 'v2';
  const tenantId = typeof req.tenantId === 'number'
    && Number.isSafeInteger(req.tenantId) && req.tenantId > 0
    ? req.tenantId
    : undefined;
  const enabled = isDecisionApiV2Enabled(process.env, {
    userId: req.userId,
    ...(tenantId ? { tenantId } : {}),
  });
  const version: DecisionApiVersion = wantsV2 && enabled ? 'v2' : 'v1';
  return { version, schemaVersion: version === 'v2' ? 'decision-center.v2' : 'decision-center.v1' };
}
