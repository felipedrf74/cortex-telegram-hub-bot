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

export type ForwardedContentPolicyCode =
  | 'CONTENT_UNSUPPORTED_TOPIC'
  | 'CONTENT_HIGH_RISK_REVIEW_REQUIRED'
  | 'CONTENT_RESEARCH_REQUIRED'
  | 'CONTENT_RESEARCH_QUERY_INVALID';

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

/** Public-safe Content safety/grounding denial forwarded by the Python hop. */
export class ForwardedContentPolicyError extends Error {
  readonly status = 422 as const;
  readonly publicMessage: string;
  readonly details: Readonly<{ retryable: false }>;

  constructor(readonly code: ForwardedContentPolicyCode) {
    super(code);
    this.name = 'ForwardedContentPolicyError';
    this.publicMessage = FORWARDED_CONTENT_POLICY_MESSAGES[code];
    this.details = Object.freeze({ retryable: false });
  }
}

const FORWARDED_AI_BUDGET_CODES = new Set<ForwardedAiBudgetCode>([
  'AI_PLAN_REQUIRED',
  'AI_DAILY_LIMIT_REACHED',
  'AI_MONTHLY_LIMIT_REACHED',
  'SERVICE_DEGRADED',
]);

const FORWARDED_AI_BUDGET_MESSAGES: Record<ForwardedAiBudgetCode, string> = {
  AI_PLAN_REQUIRED: 'An active paid plan is required.',
  AI_DAILY_LIMIT_REACHED: 'Daily AI quota reached.',
  AI_MONTHLY_LIMIT_REACHED: 'Monthly AI quota reached.',
  SERVICE_DEGRADED: 'AI service is temporarily unavailable.',
};

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

const FORWARDED_LOCAL_INFERENCE_MESSAGES: Record<ForwardedLocalInferenceCode, string> = {
  LOCAL_PRIMARY_DISABLED: 'Local-primary Content inference is not enabled.',
  LOCAL_PLAN_REQUIRED: 'This plan does not include model-backed local operations.',
  LOCAL_FAIR_USE_REACHED: 'Local model fair-use limit reached.',
  LOCAL_CAPACITY_BUSY: 'Local inference capacity is temporarily busy.',
  LOCAL_QUEUE_FULL: 'Local inference queue is full.',
  LOCAL_QUEUE_DEADLINE: 'Local inference request expired while waiting for capacity.',
  LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE: 'Local inference attribution is temporarily unavailable.',
  INTERNAL_ATTRIBUTION_INVALID: 'Signed Content inference scope was rejected.',
  INTERNAL_INFERENCE_ATTRIBUTION_INVALID: 'Signed Content inference scope was rejected.',
  INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH: 'Signed Content inference scope was rejected.',
  ACCOUNT_DELETION_IN_PROGRESS: 'No new Content inference can start while this account is being deleted.',
  PRIVATE_LOCAL_ROUTE_UNAVAILABLE: 'This private workload is local-only and local routing is not currently available.',
  INFERENCE_PROVIDER_UNAVAILABLE: 'Inference provider routing is unavailable.',
  INFERENCE_CONTEXT_LIMIT_EXCEEDED: 'The compiled inference context exceeds this plan and model limit.',
  INFERENCE_EMPTY_OUTPUT: 'Inference provider returned no usable output.',
  INFERENCE_SCHEMA_VALUE_INVALID: 'Inference output did not match the server-owned schema.',
  LOCAL_INFERENCE_FAILED: 'Local content generation is temporarily unavailable.',
};

const FORWARDED_CONTENT_POLICY_MESSAGES: Record<ForwardedContentPolicyCode, string> = {
  CONTENT_UNSUPPORTED_TOPIC: 'This request is not supported for content generation.',
  CONTENT_HIGH_RISK_REVIEW_REQUIRED: 'This request requires reviewer-attested authority before content generation.',
  CONTENT_RESEARCH_REQUIRED: 'Usable research evidence is required before this content can be generated.',
  CONTENT_RESEARCH_QUERY_INVALID: 'The research query did not match the requested content subject.',
};

const FORWARDED_CONTENT_POLICY_CODES = new Set<ForwardedContentPolicyCode>(
  Object.keys(FORWARDED_CONTENT_POLICY_MESSAGES) as ForwardedContentPolicyCode[],
);

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

function boundedMachineToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function boundedTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function boundedNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
    ? Number(value)
    : undefined;
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
  const details: Record<string, unknown> = {};
  for (const key of ['window', 'requiredPlan', 'currentPlan', 'blockReason'] as const) {
    const safeValue = boundedMachineToken(detailRecord[key]);
    if (safeValue !== undefined) details[key] = safeValue;
  }
  for (const key of ['resetAt', 'unblocksAt', 'dailyResetAt', 'monthlyResetAt'] as const) {
    const safeValue = boundedTimestamp(detailRecord[key]);
    if (safeValue !== undefined) details[key] = safeValue;
  }
  if (typeof detailRecord.retryable === 'boolean') {
    details.retryable = detailRecord.retryable;
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  if (status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
    details.retryAfterSeconds = Math.min(2_678_400, Math.max(1, Math.ceil(retryAfter)));
  }
  return new ForwardedAiBudgetError({
    code: code as ForwardedAiBudgetCode,
    status,
    message: FORWARDED_AI_BUDGET_MESSAGES[code as ForwardedAiBudgetCode],
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
  if (typeof candidateDetails.retryable === 'boolean') {
    details.retryable = candidateDetails.retryable;
  }
  for (const key of ['hourlyLimit', 'dailyLimit', 'contextLimitTokens'] as const) {
    const safeValue = boundedNonNegativeInteger(candidateDetails[key]);
    if (safeValue !== undefined) details[key] = safeValue;
  }
  if (!Object.prototype.hasOwnProperty.call(details, 'retryable')) {
    details.retryable = expectedStatus >= 500;
  }
  return new ForwardedLocalInferenceError({
    code,
    status: expectedStatus,
    message: FORWARDED_LOCAL_INFERENCE_MESSAGES[code],
    details,
  });
}

export function parseForwardedContentPolicyError(
  res: Response,
  rawBody: string,
): ForwardedContentPolicyError | null {
  if (res.status !== 422) return null;
  const error = parseErrorEnvelope(rawBody);
  if (!error || typeof error.code !== 'string') return null;
  const code = error.code as ForwardedContentPolicyCode;
  return FORWARDED_CONTENT_POLICY_CODES.has(code)
    ? new ForwardedContentPolicyError(code)
    : null;
}

export function parseForwardedContentEngineError(
  res: Response,
  rawBody: string,
): ForwardedAiBudgetError | ForwardedLocalInferenceError | ForwardedContentPolicyError | null {
  return parseForwardedAiBudgetError(res, rawBody)
    ?? parseForwardedLocalInferenceError(res, rawBody)
    ?? parseForwardedContentPolicyError(res, rawBody);
}
