// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { SkillInferencePolicyError } from './skill-inference-account-lifecycle';

export interface PublicContentScriptEditInferenceError {
  code: string;
  message: string;
  status: 400 | 403 | 409 | 413 | 429 | 502 | 503;
  details: Record<string, unknown>;
  retryAfterSeconds?: 60;
}

type PublicContentScriptEditInferenceErrorTemplate = Omit<
  PublicContentScriptEditInferenceError,
  'details'
>;

const CONTENT_SCRIPT_EDIT_INFERENCE_ERRORS = new Map<
  string,
  PublicContentScriptEditInferenceErrorTemplate
>([
  ['INFERENCE_CONTEXT_LIMIT_EXCEEDED', {
    code: 'INFERENCE_CONTEXT_LIMIT_EXCEEDED',
    message: 'The compiled edit context exceeds the available model limit.',
    status: 400,
  }],
  ['LOCAL_PLAN_REQUIRED', {
    code: 'LOCAL_PLAN_REQUIRED',
    message: 'This plan does not include model-backed local operations.',
    status: 403,
  }],
  ['ACCOUNT_DELETION_IN_PROGRESS', {
    code: 'ACCOUNT_DELETION_IN_PROGRESS',
    message: 'No new Content edit can start while this account is being deleted.',
    status: 409,
  }],
  ['input_token_overflow', {
    code: 'CONTENT_SCRIPT_INPUT_TOO_LARGE',
    message: 'The script edit context exceeds the supported model input size; the original script was preserved.',
    status: 413,
  }],
  ['LOCAL_FAIR_USE_REACHED', {
    code: 'LOCAL_FAIR_USE_REACHED',
    message: 'Local model fair-use limit reached.',
    status: 429,
    retryAfterSeconds: 60,
  }],
  ['INFERENCE_EMPTY_OUTPUT', {
    code: 'INFERENCE_EMPTY_OUTPUT',
    message: 'Local inference returned no usable edit; the original script was preserved.',
    status: 502,
  }],
  ['LOCAL_CAPACITY_BUSY', {
    code: 'LOCAL_CAPACITY_BUSY',
    message: 'Local inference capacity is temporarily busy.',
    status: 503,
    retryAfterSeconds: 60,
  }],
  ['LOCAL_QUEUE_FULL', {
    code: 'LOCAL_QUEUE_FULL',
    message: 'Local inference queue is full.',
    status: 503,
    retryAfterSeconds: 60,
  }],
  ['LOCAL_QUEUE_DEADLINE', {
    code: 'LOCAL_QUEUE_DEADLINE',
    message: 'Local inference request expired while waiting for capacity.',
    status: 503,
    retryAfterSeconds: 60,
  }],
  ['FREE_TIER_LOCAL_CAPACITY', {
    code: 'FREE_TIER_LOCAL_CAPACITY',
    message: 'Free-plan AI runs on Nexus local capacity only. Please retry shortly.',
    status: 503,
    retryAfterSeconds: 60,
  }],
  ['PRIVATE_LOCAL_ROUTE_UNAVAILABLE', {
    code: 'PRIVATE_LOCAL_ROUTE_UNAVAILABLE',
    message: 'This private edit is local-only and local routing is not currently available.',
    status: 503,
    retryAfterSeconds: 60,
  }],
  ['INFERENCE_PROVIDER_UNAVAILABLE', {
    code: 'INFERENCE_PROVIDER_UNAVAILABLE',
    message: 'Inference provider routing is unavailable.',
    status: 503,
    retryAfterSeconds: 60,
  }],
]);

const CONTENT_SCRIPT_EDIT_UNAVAILABLE: PublicContentScriptEditInferenceErrorTemplate = {
  code: 'CONTENT_SCRIPT_EDIT_UNAVAILABLE',
  message: 'Content script editing is temporarily unavailable; the original script was preserved.',
  status: 503,
  retryAfterSeconds: 60,
};

/**
 * Close the public edit-error vocabulary at the HTTP boundary. In particular,
 * LocalLLMError is converted to SkillInferencePolicyError with provider-owned
 * metadata, so its original message and details must never cross this route.
 */
export function mapContentScriptEditInferenceError(
  error: SkillInferencePolicyError,
): PublicContentScriptEditInferenceError {
  const mapped = CONTENT_SCRIPT_EDIT_INFERENCE_ERRORS.get(error.code)
    ?? CONTENT_SCRIPT_EDIT_UNAVAILABLE;
  return {
    ...mapped,
    details: { originalPreserved: true },
  };
}
