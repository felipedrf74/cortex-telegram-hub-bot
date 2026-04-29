// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleTriathlon(message: string, userId?: number, tenantId?: number): Promise<DomainResponse> {
  return handleSimpleDomain('triathlon', message, 5, userId, undefined, tenantId);
}
