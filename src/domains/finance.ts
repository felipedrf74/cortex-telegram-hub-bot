// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleFinance(message: string, userId?: number): Promise<DomainResponse> {
  return handleSimpleDomain('finance', message, 5, userId);
}
