// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleContent(
  message: string,
  userId?: number,
  tenantId?: number,
  abortSignal?: AbortSignal,
  maxTokensOverride?: number,
): Promise<DomainResponse> {
  return handleSimpleDomain(
    'content',
    message,
    5,
    userId,
    maxTokensOverride,
    tenantId,
    undefined,
    abortSignal,
  );
}
