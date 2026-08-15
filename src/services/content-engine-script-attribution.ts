// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { generateRequestId, getCurrentRequestId } from '../utils/request-context';
import { createInternalAttributionToken } from './internal-attribution';
import { createInternalInferenceAttributionGrant } from './internal-inference-attribution';
import {
  buildContentEngineScriptCategory,
  CONTENT_ENGINE_DEEP_SEARCH_CATEGORY,
} from './local-inference-vocabulary';
import { ForwardedLocalInferenceError } from './content-engine-error-contract';

export interface ContentEngineScriptAttributionInput {
  contentProxyEnabled: boolean;
  providerBoundarySupplied: boolean;
  userId?: number;
  tenantId?: number;
  mode: string;
  operationId?: string;
}

/**
 * Mint attribution at the fresh-provider boundary, after token-zero cache
 * lookup. Local-primary calls carry identity and privacy claims only; the
 * legacy cloud token is minted only when a cloud budget boundary already owns
 * the call or the local Content proxy is disabled.
 */
export function buildContentEngineScriptAttribution(
  input: ContentEngineScriptAttributionInput,
): {
  internal_attribution_token?: string;
  internal_inference_attribution_token?: string;
  internal_inference_proof_key?: string;
} {
  const category = buildContentEngineScriptCategory(input.mode);
  const userId = input.userId ?? 0;
  const tenantId = input.tenantId ?? input.userId ?? 0;
  if (!input.contentProxyEnabled || input.providerBoundarySupplied) {
    return {
      internal_attribution_token: createInternalAttributionToken({
        userId,
        tenantId,
        category,
      }) ?? undefined,
    };
  }
  const inferenceGrant = createInternalInferenceAttributionGrant({
    userId,
    tenantId,
    category,
    additionalCategories: input.mode.trim().toLowerCase() === 'deep'
      ? [CONTENT_ENGINE_DEEP_SEARCH_CATEGORY]
      : [],
    requestSource: 'interactive',
    baseCategory: category,
    jobName: 'content_script_generate',
    operationId: input.operationId ?? getCurrentRequestId() ?? generateRequestId(),
    privacyClass: 'private',
    cloudEscalationAllowed: false,
  });
  if (!inferenceGrant) {
    throw new ForwardedLocalInferenceError({
      code: 'LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE',
      status: 503,
      message: 'Local-primary Content attribution is temporarily unavailable.',
      details: { retryable: true },
    });
  }
  return {
    internal_inference_attribution_token: inferenceGrant.token,
    internal_inference_proof_key: inferenceGrant.proofKey,
  };
}
