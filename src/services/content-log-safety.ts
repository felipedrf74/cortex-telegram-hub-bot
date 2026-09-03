// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

export interface SafeContentLogErrorFields {
  errorName: string;
  errorCode?: string;
  errorFingerprint?: string;
}

function safeLogToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

function safeMachineCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * Keep provider, database, and user-derived exception messages/stacks out of
 * Content logs. Only bounded machine identifiers are retained for diagnosis.
 */
export function safeContentLogErrorFields(error: unknown): SafeContentLogErrorFields {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const errorName = safeLogToken(candidate?.name, typeof error);
  const errorCode = safeMachineCode(candidate?.code);
  const errorFingerprint = typeof candidate?.message === 'string' && candidate.message.length > 0
    ? contentLogFingerprint(candidate.message)
    : undefined;
  return {
    errorName,
    ...(errorCode ? { errorCode } : {}),
    ...(errorFingerprint ? { errorFingerprint } : {}),
  };
}

/** A stable correlation key for private Content inputs without logging them. */
export function contentLogFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
