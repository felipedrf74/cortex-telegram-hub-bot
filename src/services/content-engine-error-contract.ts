// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ForwardedAiBudgetCode =
  | 'AI_PLAN_REQUIRED'
  | 'AI_DAILY_LIMIT_REACHED'
  | 'AI_MONTHLY_LIMIT_REACHED'
  | 'SERVICE_DEGRADED';

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

const FORWARDED_AI_BUDGET_CODES = new Set<ForwardedAiBudgetCode>([
  'AI_PLAN_REQUIRED',
  'AI_DAILY_LIMIT_REACHED',
  'AI_MONTHLY_LIMIT_REACHED',
  'SERVICE_DEGRADED',
]);

export function parseForwardedAiBudgetError(res: Response, rawBody: string): ForwardedAiBudgetError | null {
  const status = res.status;
  if (status !== 403 && status !== 429) return null;
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
  const error = directError && typeof directError === 'object'
    ? directError as Record<string, unknown>
    : nestedError && typeof nestedError === 'object'
      ? nestedError as Record<string, unknown>
      : null;
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
