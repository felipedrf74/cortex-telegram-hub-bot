// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const CONTENT_IDEMPOTENCY_KEY_MIN_CHARS = 8;
export const CONTENT_IDEMPOTENCY_KEY_MAX_CHARS = 200;

export class ContentIdempotencyKeyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = { field: 'idempotencyKey' },
  ) {
    super(message);
    this.name = 'ContentIdempotencyKeyError';
  }
}

export function resolveContentIdempotencyKey(req: {
  body?: unknown;
  header(name: string): string | undefined;
}): string {
  if (req.body !== undefined && (
    req.body === null
    || typeof req.body !== 'object'
    || Array.isArray(req.body)
  )) {
    throw new ContentIdempotencyKeyError(
      'CONTENT_VALIDATION_FAILED',
      'Request body must be an object.',
      400,
      { field: 'body' },
    );
  }
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  const bodyValue = body?.idempotencyKey;
  if (bodyValue !== undefined && bodyValue !== null && typeof bodyValue !== 'string') {
    throw new ContentIdempotencyKeyError(
      'CONTENT_VALIDATION_FAILED',
      'idempotencyKey must be a string.',
      400,
    );
  }

  const bodyKey = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  const headerKey = (req.header('x-idempotency-key') ?? '').trim();
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new ContentIdempotencyKeyError(
      'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      'Body and header idempotency keys must match.',
      409,
    );
  }

  const value = bodyKey || headerKey;
  if (!value) {
    throw new ContentIdempotencyKeyError(
      'CONTENT_IDEMPOTENCY_KEY_REQUIRED',
      'Provide an idempotency key in the request body or x-idempotency-key header.',
      400,
    );
  }
  if (value.length < CONTENT_IDEMPOTENCY_KEY_MIN_CHARS
    || value.length > CONTENT_IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new ContentIdempotencyKeyError(
      'CONTENT_VALIDATION_FAILED',
      `idempotencyKey must contain ${CONTENT_IDEMPOTENCY_KEY_MIN_CHARS}-${CONTENT_IDEMPOTENCY_KEY_MAX_CHARS} characters.`,
      400,
    );
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(value)) {
    throw new ContentIdempotencyKeyError(
      'CONTENT_VALIDATION_FAILED',
      'idempotencyKey contains unsupported control characters.',
      400,
    );
  }
  return value;
}
