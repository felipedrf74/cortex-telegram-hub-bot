// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { StructuredGenerationBatchState } from './ai-provider';

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const ERROR_PARAM_PATH = /^[A-Za-z0-9_.$:[\]-]{1,160}$/u;
const ERROR_PARAM_ROOTS = new Set([
  'custom_id', 'method', 'url', 'body', 'model', 'messages',
  'max_completion_tokens', 'max_tokens', 'response_format',
]);

export interface ContentFreeOpenAIBatchErrorDiagnostic {
  errorCode?: string;
  errorLine?: 1;
  errorParam?: string;
}

export function contentFreeOpenAIBatchError(error: {
  code?: unknown;
  line?: unknown;
  param?: unknown;
} | null | undefined): ContentFreeOpenAIBatchErrorDiagnostic {
  if (!error) return {};
  const errorCode = typeof error.code === 'string' && ERROR_CODE.test(error.code)
    ? error.code : undefined;
  if (!errorCode) return {};
  const paramRoot = typeof error.param === 'string'
    ? error.param.split(/[.[]/u, 1)[0] : undefined;
  const errorParam = typeof error.param === 'string'
    && ERROR_PARAM_PATH.test(error.param)
    && paramRoot !== undefined && ERROR_PARAM_ROOTS.has(paramRoot)
    ? error.param : undefined;
  return {
    errorCode,
    ...(error.line === 1 ? { errorLine: 1 as const } : {}),
    ...(errorParam ? { errorParam } : {}),
  };
}

export function replaceContentFreeOpenAIBatchError(
  state: StructuredGenerationBatchState,
  error: { code?: unknown; line?: unknown; param?: unknown } | null | undefined,
): StructuredGenerationBatchState {
  const next = { ...state } as StructuredGenerationBatchState & Record<string, unknown>;
  delete next.errorCode;
  delete next.errorLine;
  delete next.errorParam;
  return Object.assign(next, contentFreeOpenAIBatchError(error));
}
