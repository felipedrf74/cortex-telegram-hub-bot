// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ForwardedAiBudgetCode =
  | 'AI_PLAN_REQUIRED'
  | 'AI_DAILY_LIMIT_REACHED'
  | 'AI_MONTHLY_LIMIT_REACHED'
  | 'SERVICE_DEGRADED';

export type ForwardedLocalInferenceCode =
  | 'LOCAL_PRIMARY_DISABLED'
  | 'LOCAL_PLAN_REQUIRED'
  | 'LOCAL_FAIR_USE_REACHED'
  | 'LOCAL_CAPACITY_BUSY'
  | 'LOCAL_QUEUE_FULL'
  | 'LOCAL_QUEUE_DEADLINE'
  | 'LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE'
  | 'INTERNAL_ATTRIBUTION_INVALID'
  | 'INTERNAL_INFERENCE_ATTRIBUTION_INVALID'
  | 'INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH'
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'PRIVATE_LOCAL_ROUTE_UNAVAILABLE'
  | 'INFERENCE_PROVIDER_UNAVAILABLE'
  | 'INFERENCE_CONTEXT_LIMIT_EXCEEDED'
  | 'INFERENCE_EMPTY_OUTPUT'
  | 'INFERENCE_SCHEMA_VALUE_INVALID'
  | 'LOCAL_INFERENCE_FAILED';

/** Public-safe quota denial forwarded by the Python Content Engine. */
export class ForwardedAiBudgetError extends Error {
  readonly code: ForwardedAiBudgetCode;
  readonly status: 403 | 429;
  readonly publicMessage: string;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: ForwardedAiBudgetCode;
    status: 403 | 429;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.code);
    this.name = 'ForwardedAiBudgetError';
    this.code = input.code;
    this.status = input.status;
    this.publicMessage = input.message;
    this.details = input.details ?? {};
  }
}

/** Public-safe local-primary failure forwarded across the Python service hop. */
export class ForwardedLocalInferenceError extends Error {
  readonly code: ForwardedLocalInferenceCode;
  readonly status: 400 | 403 | 409 | 429 | 502 | 503;
  readonly publicMessage: string;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: ForwardedLocalInferenceCode;
    status: 400 | 403 | 409 | 429 | 502 | 503;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.code);
    this.name = 'ForwardedLocalInferenceError';
    this.code = input.code;
    this.status = input.status;
    this.publicMessage = input.message;
    this.details = input.details ?? {};
  }
}

const FORWARDED_AI_BUDGET_CODES = new Set<ForwardedAiBudgetCode>([
  'AI_PLAN_REQUIRED',
  'AI_DAILY_LIMIT_REACHED',
  'AI_MONTHLY_LIMIT_REACHED',
  'SERVICE_DEGRADED',
]);

const FORWARDED_LOCAL_INFERENCE_STATUS = new Map<ForwardedLocalInferenceCode, 400 | 403 | 409 | 429 | 502 | 503>([
  ['LOCAL_PRIMARY_DISABLED', 409],
  ['LOCAL_PLAN_REQUIRED', 403],
  ['LOCAL_FAIR_USE_REACHED', 429],
  ['LOCAL_CAPACITY_BUSY', 503],
  ['LOCAL_QUEUE_FULL', 503],
  ['LOCAL_QUEUE_DEADLINE', 503],
  ['LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE', 503],
  ['INTERNAL_ATTRIBUTION_INVALID', 403],
  ['INTERNAL_INFERENCE_ATTRIBUTION_INVALID', 403],
  ['INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH', 403],
  ['ACCOUNT_DELETION_IN_PROGRESS', 409],
  ['PRIVATE_LOCAL_ROUTE_UNAVAILABLE', 503],
  ['INFERENCE_PROVIDER_UNAVAILABLE', 503],
  ['INFERENCE_CONTEXT_LIMIT_EXCEEDED', 400],
  ['INFERENCE_EMPTY_OUTPUT', 502],
  ['INFERENCE_SCHEMA_VALUE_INVALID', 502],
  ['LOCAL_INFERENCE_FAILED', 503],
]);

function parseErrorEnvelope(rawBody: string): Record<string, unknown> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const directError = record.error;
  const detail = record.detail;
  const nestedError = detail && typeof detail === 'object'
    ? (detail as Record<string, unknown>).error
    : null;
  return directError && typeof directError === 'object'
    ? directError as Record<string, unknown>
    : nestedError && typeof nestedError === 'object'
      ? nestedError as Record<string, unknown>
      : null;
}

export function parseForwardedAiBudgetError(res: Response, rawBody: string): ForwardedAiBudgetError | null {
  const status = res.status;
  if (status !== 403 && status !== 429) return null;
  const error = parseErrorEnvelope(rawBody);
  if (!error) return null;
  const code = error.code;
  if (typeof code !== 'string' || !FORWARDED_AI_BUDGET_CODES.has(code as ForwardedAiBudgetCode)) return null;
  const expectedStatus = code === 'AI_PLAN_REQUIRED' ? 403 : 429;
  if (status !== expectedStatus) return null;
  const rawDetails = error.details;
  const detailRecord = rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
    ? rawDetails as Record<string, unknown>
    : {};
  const forwardedDetailKeys = [
    'window', 'resetAt', 'unblocksAt', 'dailyResetAt', 'monthlyResetAt',
    'requiredPlan', 'currentPlan', 'blockReason', 'retryable',
  ] as const;
  const details: Record<string, unknown> = {};
  for (const key of forwardedDetailKeys) {
    if (Object.prototype.hasOwnProperty.call(detailRecord, key)) details[key] = detailRecord[key];
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  if (status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
    details.retryAfterSeconds = Math.min(2_678_400, Math.max(1, Math.ceil(retryAfter)));
  }
  return new ForwardedAiBudgetError({
    code: code as ForwardedAiBudgetCode,
    status,
    message: typeof error.message === 'string' && error.message.trim()
      ? error.message
      : code,
    details,
  });
}

export function parseForwardedLocalInferenceError(
  res: Response,
  rawBody: string,
): ForwardedLocalInferenceError | null {
  const error = parseErrorEnvelope(rawBody);
  if (!error || typeof error.code !== 'string') return null;
  const code = error.code as ForwardedLocalInferenceCode;
  const expectedStatus = FORWARDED_LOCAL_INFERENCE_STATUS.get(code);
  if (expectedStatus === undefined || res.status !== expectedStatus) return null;
  const rawDetails = error.details;
  const candidateDetails = rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
    ? rawDetails as Record<string, unknown>
    : {};
  const details: Record<string, unknown> = {};
  for (const key of ['retryable', 'hourlyLimit', 'dailyLimit', 'contextLimitTokens'] as const) {
    if (Object.prototype.hasOwnProperty.call(candidateDetails, key)) details[key] = candidateDetails[key];
  }
  if (!Object.prototype.hasOwnProperty.call(details, 'retryable')) {
    details.retryable = expectedStatus >= 500;
  }
  return new ForwardedLocalInferenceError({
    code,
    status: expectedStatus,
    message: typeof error.message === 'string' && error.message.trim()
      ? error.message
      : code,
    details,
  });
}

export function parseForwardedContentEngineError(
  res: Response,
  rawBody: string,
): ForwardedAiBudgetError | ForwardedLocalInferenceError | null {
  return parseForwardedAiBudgetError(res, rawBody)
    ?? parseForwardedLocalInferenceError(res, rawBody);
}
